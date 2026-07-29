import { createHash } from "node:crypto";
import puppeteer from "puppeteer-core";

const LOGIN_URL = "https://www.volosports.com/login";
const DASHBOARD_URL = "https://www.volosports.com/app/dashboard";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const TIMEZONE = "America/Denver";
const SYNC_MARKER = "soccer-team-games-v1";
const SOCCER_DURATION_MINUTES = 45;

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

async function notify(title, message, priority = "3", tags = "calendar,soccer") {
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

  if (!clicked) {
    await page.focus(passwordSelector);
    await page.keyboard.press("Enter");
  }

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

function parseGraphqlPayload(postData) {
  if (!postData) return [];
  try {
    const parsed = JSON.parse(postData);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function isSoccerScheduleOperation(operationName) {
  return /^(?:TeamGames|getTeamSchedule|GetLeaguePlayerSchedule|TournamentSchedule|getGame)$/i.test(
    operationName
  );
}

function parseTimestamp(value) {
  const text = normalize(value);
  if (!text) return null;

  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(text);
    if (!Number.isFinite(number)) return null;
    if (number >= 1_000_000_000_000) return number;
    if (number >= 1_000_000_000) return number * 1_000;
    return null;
  }

  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function collectGameObjects(value, output, path = "data", depth = 0) {
  if (depth > 14 || value == null || output.length >= 300) return;

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) {
      collectGameObjects(item, output, `${path}[]`, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") return;

  const startRaw =
    value.start_time ?? value.startTime ?? value.start_date ?? value.startDate ?? value.starts_at;
  const startTimestamp = parseTimestamp(startRaw);

  if (startTimestamp !== null) {
    const endRaw = value.end_time ?? value.endTime ?? value.end_date ?? value.endDate ?? value.ends_at;
    const gameId = normalize(value._id ?? value.id ?? value.game_id ?? value.gameId);
    const fieldName = normalize(
      value.field_name ?? value.fieldName ?? value.court_name ?? value.courtName
    );
    const venueName = normalize(
      value.venue_name ??
        value.venueName ??
        value.location_name ??
        value.locationName ??
        value.venue?.name ??
        value.location?.name ??
        value.facility?.name
    );

    output.push({
      path,
      gameId,
      startTimestamp,
      endTimestampFromVolo: parseTimestamp(endRaw),
      fieldName,
      venueName,
    });
  }

  for (const [key, child] of Object.entries(value).slice(0, 160)) {
    collectGameObjects(child, output, `${path}.${key}`, depth + 1);
  }
}

function parseProgramCard(card) {
  const parts = card.text.split(/\s+-\s+/).map(normalize).filter(Boolean);
  const headline = parts[0] || "Soccer";
  const teamName = normalize(headline.replace(/\s+Soccer\b.*$/i, "")) || headline;
  const venue = parts[2] || "";
  return {
    ...card,
    teamName,
    programName: headline,
    venue,
  };
}

async function collectSoccerCards(page) {
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

  const cards = await page.evaluate(() => {
    const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const seen = new Set();
    const results = [];

    for (const link of document.querySelectorAll('a[href*="/app/member/"]')) {
      const match = link.href.match(/\/app\/member\/([^/?#]+)/i);
      const routeId = match?.[1] || "";
      if (!routeId) continue;

      let text = clean(link.innerText || link.textContent);
      if (!/\bsoccer\b/i.test(text)) {
        let ancestor = link.parentElement;
        for (let depth = 0; ancestor && depth < 6; depth += 1, ancestor = ancestor.parentElement) {
          const candidate = clean(ancestor.innerText || ancestor.textContent);
          if (/\bsoccer\b/i.test(candidate) && candidate.length <= 900) {
            text = candidate;
            break;
          }
        }
      }

      if (!/\bsoccer\b/i.test(text)) continue;
      const identity = `${routeId}|${text}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      results.push({ routeId, text, href: link.href });
    }

    return results.slice(0, 30);
  });

  return cards.map(parseProgramCard);
}

async function loadUpcomingSoccerGames() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const captures = [];
  const pending = new Set();
  let activeProgram = null;

  try {
    const page = await browser.newPage();
    await configurePage(page);

    page.on("response", (response) => {
      const programSnapshot = activeProgram;
      const task = (async () => {
        if (!programSnapshot) return;
        if (!/\/hapi\/v1\/graphql(?:\?|$)/i.test(response.url())) return;

        const payloads = parseGraphqlPayload(response.request().postData());
        if (payloads.length === 0) return;

        let responseJson;
        try {
          responseJson = await response.json();
        } catch {
          return;
        }

        const responseItems = Array.isArray(responseJson) ? responseJson : [responseJson];
        for (let index = 0; index < payloads.length; index += 1) {
          const operationName = normalize(payloads[index]?.operationName);
          if (!isSoccerScheduleOperation(operationName)) continue;

          const games = [];
          collectGameObjects(responseItems[index] ?? responseItems[0], games);
          if (games.length === 0) continue;

          captures.push({
            operationName,
            program: programSnapshot,
            games,
          });
        }
      })()
        .catch(() => {})
        .finally(() => pending.delete(task));
      pending.add(task);
    });

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => {});
    await submitLogin(page);

    if (!/\/app\/dashboard(?:\/|$|\?)/i.test(page.url())) {
      await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 25_000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    const programs = await collectSoccerCards(page);

    for (const program of programs) {
      await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForNetworkIdle({ idleTime: 750, timeout: 15_000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      activeProgram = program;
      const clicked = await page.evaluate((routeId) => {
        const links = [...document.querySelectorAll('a[href*="/app/member/"]')];
        const target = links.find((link) => link.href.includes(`/app/member/${routeId}`));
        if (!target) return false;
        target.click();
        return true;
      }, program.routeId);

      if (!clicked) {
        await page.goto(program.href, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null);
      }

      await page.waitForNetworkIdle({ idleTime: 750, timeout: 20_000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await Promise.allSettled([...pending]);
      activeProgram = null;
    }

    await Promise.allSettled([...pending]);

    const now = Date.now();
    const byIdentity = new Map();

    for (const capture of captures) {
      for (const game of capture.games) {
        if (game.startTimestamp < now - 3 * 60 * 60 * 1_000) continue;
        if (game.startTimestamp > now + 180 * 24 * 60 * 60 * 1_000) continue;

        const fallbackIdentity = hashText(
          `${capture.program.routeId}|${game.startTimestamp}|${game.fieldName}|${capture.program.teamName}`
        );
        const gameKey = game.gameId || fallbackIdentity;
        if (byIdentity.has(gameKey)) continue;

        const venue = game.venueName || capture.program.venue;
        const location = [game.fieldName, venue].filter(Boolean).join(" — ");
        byIdentity.set(gameKey, {
          gameKey,
          gameId: game.gameId,
          routeId: capture.program.routeId,
          teamName: capture.program.teamName,
          programName: capture.program.programName,
          venue,
          fieldName: game.fieldName,
          location,
          startTimestamp: game.startTimestamp,
          endTimestamp: game.startTimestamp + SOCCER_DURATION_MINUTES * 60 * 1_000,
          sourceEndTimestamp: game.endTimestampFromVolo,
          sourceOperation: capture.operationName,
          url: `https://www.volosports.com/app/member/${encodeURIComponent(capture.program.routeId)}`,
        });
      }
    }

    return {
      programCount: programs.length,
      captureCount: captures.length,
      games: [...byIdentity.values()].sort((left, right) => left.startTimestamp - right.startTimestamp),
    };
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

async function listManagedSoccerEvents(now = Date.now()) {
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
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

function eventBody(game) {
  return {
    summary: `Soccer — ${game.teamName}`,
    location: game.location || undefined,
    description: [
      "Synced automatically from your authenticated Volo Sports soccer schedule.",
      `Program: ${game.programName}`,
      game.fieldName ? `Field: ${game.fieldName}` : "",
      game.venue ? `Venue: ${game.venue}` : "",
      "Calendar changes do not change or cancel your Volo registration.",
      game.url,
    ]
      .filter(Boolean)
      .join("\n"),
    start: {
      dateTime: new Date(game.startTimestamp).toISOString(),
      timeZone: TIMEZONE,
    },
    end: {
      dateTime: new Date(game.endTimestamp).toISOString(),
      timeZone: TIMEZONE,
    },
    source: {
      title: "Volo Sports",
      url: game.url,
    },
    extendedProperties: {
      private: {
        voloSync: SYNC_MARKER,
        voloGameKey: game.gameKey,
        voloGameId: game.gameId || "",
        voloProgramRouteId: game.routeId,
        voloSource: game.sourceOperation,
        voloDurationMinutes: String(SOCCER_DURATION_MINUTES),
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

async function syncSoccerGames(games) {
  const existing = await listManagedSoccerEvents();
  const byGameKey = new Map();

  for (const event of existing) {
    const gameKey = event.extendedProperties?.private?.voloGameKey;
    if (gameKey && !byGameKey.has(gameKey)) byGameKey.set(gameKey, event);
  }

  const actions = [];
  for (const game of games) {
    const body = eventBody(game);
    const current = byGameKey.get(game.gameKey);

    if (!current) {
      actions.push({ type: "create", game, body });
      if (!DRY_RUN) {
        await calendarRequest(calendarUrl("/events"), {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      continue;
    }

    if (comparableEvent(current) !== comparableEvent(body)) {
      actions.push({ type: "update", game, body, eventId: current.id });
      if (!DRY_RUN) {
        await calendarRequest(calendarUrl(`/events/${encodeURIComponent(current.id)}`), {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      }
    } else {
      actions.push({ type: "unchanged", game, eventId: current.id });
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
    const dashboard = await loadUpcomingSoccerGames();
    if (dashboard.programCount === 0) {
      throw new Error("Volo login succeeded, but no authenticated soccer program cards were found.");
    }

    const result = await syncSoccerGames(dashboard.games);
    const created = result.actions.filter((action) => action.type === "create");
    const updated = result.actions.filter((action) => action.type === "update");
    const unchanged = result.actions.filter((action) => action.type === "unchanged");

    const actionExamples = [...created, ...updated]
      .slice(0, 12)
      .map(
        (action, index) =>
          `${index + 1}. ${action.type}: Soccer — ${action.game.teamName} | ${formatDenverTime(
            action.game.startTimestamp
          )} | ${SOCCER_DURATION_MINUTES} min${action.game.location ? ` | ${action.game.location}` : ""}`
      );

    const message = [
      DRY_RUN ? "Dry run: no soccer calendar changes were made." : "Soccer calendar create/update sync completed.",
      `Authenticated soccer programs: ${dashboard.programCount}.`,
      `Schedule responses captured: ${dashboard.captureCount}.`,
      `Upcoming soccer games: ${dashboard.games.length}.`,
      `Created: ${created.length}. Updated: ${updated.length}. Unchanged: ${unchanged.length}.`,
      "Soccer event duration: 45 minutes.",
      "Deletion sync is disabled.",
      actionExamples.length ? `Changes:\n${actionExamples.join("\n")}` : "No soccer calendar changes were needed.",
    ].join("\n");

    console.log(
      JSON.stringify(
        {
          dryRun: DRY_RUN,
          soccerProgramCount: dashboard.programCount,
          scheduleCaptureCount: dashboard.captureCount,
          upcomingSoccerGameCount: dashboard.games.length,
          existingManagedSoccerEventCount: result.existingCount,
          createdCount: created.length,
          updatedCount: updated.length,
          unchangedCount: unchanged.length,
          soccerDurationMinutes: SOCCER_DURATION_MINUTES,
          deletionEnabled: false,
        },
        null,
        2
      )
    );

    if (DRY_RUN || created.length > 0 || updated.length > 0) {
      await notify(
        DRY_RUN ? "Volo soccer calendar dry run" : "Volo soccer calendar synced",
        message,
        "3",
        DRY_RUN ? "calendar,soccer,magnifying_glass_tilted_left" : "calendar,soccer,white_check_mark"
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    await notify("Volo soccer calendar sync failed", sanitize(message).slice(0, 800), "4", "calendar,soccer,warning").catch(
      (notificationError) => console.error("Could not send soccer sync failure notification:", notificationError)
    );
    process.exitCode = 1;
  }
}

await main();
