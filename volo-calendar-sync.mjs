import { createHash } from "node:crypto";
import puppeteer from "puppeteer-core";

const LOGIN_URL = "https://www.volosports.com/login";
const DASHBOARD_URL = "https://www.volosports.com/app/dashboard";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const TIMEZONE = "America/Denver";
const SYNC_MARKER = "dashboard-card-v1";
const DEFAULT_DURATION_MINUTES = 90;

const VOLO_EMAIL = requiredEnv("VOLO_EMAIL");
const VOLO_PASSWORD = requiredEnv("VOLO_PASSWORD");
const GOOGLE_ACCESS_TOKEN = requiredEnv("GOOGLE_ACCESS_TOKEN");
const GOOGLE_CALENDAR_ID = requiredEnv("GOOGLE_CALENDAR_ID");
const NTFY_TOPIC = requiredEnv("NTFY_TOPIC");
const DRY_RUN = /^(?:1|true|yes)$/i.test(process.env.DRY_RUN || "false");

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sanitize(value) {
  return normalize(value)
    .replaceAll(VOLO_EMAIL, "[email]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\/app\/member\/[0-9a-f-]{20,}/gi, "/app/member/[redacted]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[id]")
    .slice(0, 4_000);
}

async function notify(title, message, priority = "3", tags = "calendar") {
  const response = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Title: title,
      Priority: priority,
      Tags: tags,
    },
    body: message,
  });

  if (!response.ok) {
    throw new Error(`ntfy returned HTTP ${response.status}: ${await response.text()}`);
  }
}

async function firstExistingSelector(page, selectors) {
  for (const selector of selectors) {
    if (await page.$(selector)) return selector;
  }
  return null;
}

async function configurePage(page) {
  await page.emulateTimezone(TIMEZONE);
  await page.setViewport({ width: 1440, height: 1400, deviceScaleFactor: 1 });
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
  );
}

async function submitLogin(page) {
  const emailSelector = await firstExistingSelector(page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[autocomplete="username"]',
  ]);
  const passwordSelector = await firstExistingSelector(page, [
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]',
  ]);

  if (!emailSelector || !passwordSelector) {
    throw new Error("Could not find the Volo email or password field.");
  }

  await page.click(emailSelector, { clickCount: 3 });
  await page.type(emailSelector, VOLO_EMAIL, { delay: 15 });
  await page.click(passwordSelector, { clickCount: 3 });
  await page.type(passwordSelector, VOLO_PASSWORD, { delay: 15 });

  const navigation = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 })
    .catch(() => null);

  const clicked = await page.evaluate(() => {
    const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const controls = [
      ...document.querySelectorAll('button, input[type="submit"], [role="button"]'),
    ];
    const target = controls.find((element) =>
      /^(?:log in with email|log in|sign in)$/i.test(
        clean(element.innerText || element.value || element.textContent)
      )
    );
    if (!target) return false;
    target.click();
    return true;
  });

  if (!clicked) await page.press(passwordSelector, "Enter");
  await navigation;
  await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  const status = await page.evaluate(() => ({
    url: location.href,
    body: String(document.body?.innerText ?? "").replace(/\s+/g, " ").trim(),
  }));

  if (
    /\/login(?:\/|$|\?)/i.test(status.url) ||
    /incorrect|invalid|unable to log in|wrong password/i.test(status.body)
  ) {
    throw new Error("Volo did not accept the stored email/password login.");
  }
}

function timezoneOffsetMs(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));

  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])
  );
  const asUtc = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    values.second
  );
  return asUtc - timestamp;
}

function denverTimestamp(year, month, day, hour, minute) {
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let timestamp = desiredUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    timestamp = desiredUtc - timezoneOffsetMs(timestamp, TIMEZONE);
  }
  return timestamp;
}

function parseCardDateTime(text, now = Date.now()) {
  const dateMatch = text.match(
    /\b(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+(\d{1,2})\/(\d{1,2})\b/i
  );
  if (!dateMatch) return null;

  const timeMatches = [...text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)];
  const timeMatch = timeMatches.at(-1);
  if (!timeMatch) return null;

  const month = Number(dateMatch[1]);
  const day = Number(dateMatch[2]);
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] || 0);
  const meridiem = timeMatch[3].toLowerCase();
  if (hour === 12) hour = 0;
  if (meridiem === "pm") hour += 12;

  const currentYear = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, year: "numeric" }).format(
      new Date(now)
    )
  );
  const candidates = [currentYear - 1, currentYear, currentYear + 1].map((year) => ({
    year,
    timestamp: denverTimestamp(year, month, day, hour, minute),
  }));
  candidates.sort((left, right) => Math.abs(left.timestamp - now) - Math.abs(right.timestamp - now));
  return candidates[0];
}

function parseCardDetails(card, now = Date.now()) {
  const parsedDate = parseCardDateTime(card.text, now);
  if (!parsedDate) return null;

  const weekdayDate = /\b(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+\d{1,2}\/\d{1,2}\b/i;
  const dateMatch = weekdayDate.exec(card.text);
  const teamName = dateMatch ? normalize(card.text.slice(0, dateMatch.index)) : "";
  const sessionMatch = card.text.match(
    /\b(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+\d{1,2}\/\d{1,2}\s*-\s*(.+?)\s*-\s*(.+?)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i
  );

  const activity = normalize(sessionMatch?.[1] || "Volo Sports Session");
  const location = normalize(sessionMatch?.[2] || "");
  const startTimestamp = parsedDate.timestamp;
  const endTimestamp = startTimestamp + DEFAULT_DURATION_MINUTES * 60 * 1_000;
  const url = `https://www.volosports.com/app/member/${encodeURIComponent(card.routeId)}`;

  return {
    routeId: card.routeId,
    rawText: card.text,
    teamName,
    activity,
    location,
    startTimestamp,
    endTimestamp,
    url,
  };
}

async function collectDashboardCards(page) {
  await page.evaluate(async () => {
    let previousHeight = 0;
    for (let step = 0; step < 16; step += 1) {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((resolve) => setTimeout(resolve, 350));
      const height = document.body.scrollHeight;
      if (height === previousHeight && step >= 4) break;
      previousHeight = height;
    }
    window.scrollTo(0, 0);
  });

  return await page.evaluate(() => {
    const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const seen = new Set();
    const cards = [];

    for (const link of document.querySelectorAll('a[href*="/app/member/"]')) {
      const match = link.href.match(/\/app\/member\/([^/?#]+)/i);
      const routeId = match?.[1] || "";
      const text = clean(link.innerText || link.textContent);
      if (!routeId || !text) continue;
      const identity = `${routeId}|${text}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      cards.push({ routeId, text });
    }

    return cards.slice(0, 300);
  });
}

async function loadUpcomingSessions() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    await configurePage(page);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => {});
    await submitLogin(page);

    if (!/\/app\/dashboard(?:\/|$|\?)/i.test(page.url())) {
      await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 25_000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const cards = await collectDashboardCards(page);
    const now = Date.now();
    const sessions = cards
      .map((card) => parseCardDetails(card, now))
      .filter(Boolean)
      .filter((session) => session.startTimestamp >= now - 3 * 60 * 60 * 1_000)
      .filter((session) => session.startTimestamp <= now + 180 * 24 * 60 * 60 * 1_000)
      .sort((left, right) => left.startTimestamp - right.startTimestamp);

    return { cardCount: cards.length, sessions };
  } finally {
    await browser.close();
  }
}

function calendarUrl(path, params = {}) {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}${path}`
  );
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

async function calendarRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GOOGLE_ACCESS_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Calendar HTTP ${response.status}: ${body.slice(0, 500)}`);
  }

  if (response.status === 204) return null;
  return await response.json();
}

async function listManagedEvents(now = Date.now()) {
  const events = [];
  let pageToken = "";
  do {
    const data = await calendarRequest(
      calendarUrl("/events", {
        singleEvents: true,
        showDeleted: false,
        maxResults: 2500,
        timeMin: new Date(now - 24 * 60 * 60 * 1_000).toISOString(),
        timeMax: new Date(now + 180 * 24 * 60 * 60 * 1_000).toISOString(),
        privateExtendedProperty: `voloSync=${SYNC_MARKER}`,
        pageToken: pageToken || undefined,
      })
    );
    events.push(...(data.items || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return events;
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function eventBody(session) {
  return {
    summary: session.activity,
    location: session.location || undefined,
    description: [
      "Synced automatically from your authenticated Volo Sports dashboard.",
      session.teamName ? `Volo team: ${session.teamName}` : "",
      "Calendar changes do not change or cancel your Volo registration.",
      session.url,
    ]
      .filter(Boolean)
      .join("\n"),
    start: {
      dateTime: new Date(session.startTimestamp).toISOString(),
      timeZone: TIMEZONE,
    },
    end: {
      dateTime: new Date(session.endTimestamp).toISOString(),
      timeZone: TIMEZONE,
    },
    source: {
      title: "Volo Sports",
      url: session.url,
    },
    extendedProperties: {
      private: {
        voloSync: SYNC_MARKER,
        voloRouteId: session.routeId,
        voloCardHash: hashText(session.rawText),
        voloDurationMinutes: String(DEFAULT_DURATION_MINUTES),
      },
    },
  };
}

function comparableEvent(event) {
  const startTimestamp = Date.parse(event.start?.dateTime || "");
  const endTimestamp = Date.parse(event.end?.dateTime || "");
  return JSON.stringify({
    summary: event.summary || "",
    location: event.location || "",
    description: event.description || "",
    startTimestamp: Number.isFinite(startTimestamp) ? startTimestamp : null,
    endTimestamp: Number.isFinite(endTimestamp) ? endTimestamp : null,
    source: event.source || {},
    extendedProperties: event.extendedProperties || {},
  });
}

async function syncSessions(sessions) {
  const existing = await listManagedEvents();
  const byRouteId = new Map();
  for (const event of existing) {
    const routeId = event.extendedProperties?.private?.voloRouteId;
    if (routeId && !byRouteId.has(routeId)) byRouteId.set(routeId, event);
  }

  const actions = [];
  for (const session of sessions) {
    const body = eventBody(session);
    const current = byRouteId.get(session.routeId);

    if (!current) {
      actions.push({ type: "create", session, body });
      if (!DRY_RUN) {
        await calendarRequest(calendarUrl("/events"), {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      continue;
    }

    if (comparableEvent(current) !== comparableEvent(body)) {
      actions.push({ type: "update", session, body, eventId: current.id });
      if (!DRY_RUN) {
        await calendarRequest(calendarUrl(`/events/${encodeURIComponent(current.id)}`), {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      }
    } else {
      actions.push({ type: "unchanged", session, eventId: current.id });
    }
  }

  return { actions, existingCount: existing.length };
}

function formatDenverTime(timestamp) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

async function main() {
  try {
    const dashboard = await loadUpcomingSessions();
    if (dashboard.cardCount === 0) {
      throw new Error("Volo login succeeded, but no authenticated dashboard member cards were found.");
    }

    const result = await syncSessions(dashboard.sessions);
    const created = result.actions.filter((action) => action.type === "create");
    const updated = result.actions.filter((action) => action.type === "update");
    const unchanged = result.actions.filter((action) => action.type === "unchanged");

    const actionExamples = [...created, ...updated]
      .slice(0, 8)
      .map(
        (action, index) =>
          `${index + 1}. ${action.type}: ${action.session.activity} | ${formatDenverTime(
            action.session.startTimestamp
          )}${action.session.location ? ` | ${action.session.location}` : ""}`
      );

    const message = [
      DRY_RUN ? "Dry run: no calendar changes were made." : "Calendar create/update sync completed.",
      `Authenticated dashboard cards: ${dashboard.cardCount}.`,
      `Upcoming registered sessions: ${dashboard.sessions.length}.`,
      `Created: ${created.length}. Updated: ${updated.length}. Unchanged: ${unchanged.length}.`,
      "Deletion sync is disabled.",
      actionExamples.length ? `Changes:\n${actionExamples.join("\n")}` : "No calendar changes were needed.",
    ].join("\n");

    console.log(
      JSON.stringify(
        {
          dryRun: DRY_RUN,
          dashboardCardCount: dashboard.cardCount,
          upcomingSessionCount: dashboard.sessions.length,
          existingManagedEventCount: result.existingCount,
          createdCount: created.length,
          updatedCount: updated.length,
          unchangedCount: unchanged.length,
          deletionEnabled: false,
        },
        null,
        2
      )
    );

    if (DRY_RUN || created.length > 0 || updated.length > 0) {
      await notify(
        DRY_RUN ? "Volo calendar sync dry run" : "Volo calendar synced",
        message,
        "3",
        DRY_RUN ? "calendar,magnifying_glass_tilted_left" : "calendar,white_check_mark"
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    await notify("Volo calendar sync failed", sanitize(message).slice(0, 800), "4", "calendar,warning").catch(
      (notificationError) => console.error("Could not send sync failure notification:", notificationError)
    );
    process.exitCode = 1;
  }
}

await main();
