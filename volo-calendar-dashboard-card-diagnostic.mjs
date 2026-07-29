import puppeteer from "puppeteer-core";

const LOGIN_URL = "https://www.volosports.com/login";
const DASHBOARD_URL = "https://www.volosports.com/app/dashboard";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const TIMEZONE = "America/Denver";

const VOLO_EMAIL = requiredEnv("VOLO_EMAIL");
const VOLO_PASSWORD = requiredEnv("VOLO_PASSWORD");
const GOOGLE_ACCESS_TOKEN = requiredEnv("GOOGLE_ACCESS_TOKEN");
const GOOGLE_CALENDAR_ID = requiredEnv("GOOGLE_CALENDAR_ID");
const NTFY_TOPIC = requiredEnv("NTFY_TOPIC");

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

async function notify(title, message, priority = "3", tags = "calendar,magnifying_glass_tilted_left") {
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

async function verifyCalendarAccess() {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}`,
    { headers: { Authorization: `Bearer ${GOOGLE_ACCESS_TOKEN}` } }
  );

  if (!response.ok) {
    throw new Error(`Google Calendar access failed with HTTP ${response.status}`);
  }

  const calendar = await response.json();
  return normalize(calendar.summary) || "Volo";
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

function parseGraphqlPayload(postData) {
  if (!postData) return [];
  try {
    const parsed = JSON.parse(postData);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
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

  const timeMatches = [
    ...text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi),
  ];
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

  candidates.sort(
    (left, right) => Math.abs(left.timestamp - now) - Math.abs(right.timestamp - now)
  );
  return candidates[0];
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

async function inspectDashboard() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  let myDropInRsvpsResponses = 0;
  let getDropInInfoResponses = 0;
  const pending = new Set();

  try {
    const page = await browser.newPage();
    await configurePage(page);

    page.on("response", (response) => {
      const task = (async () => {
        if (!/\/hapi\/v1\/graphql(?:\?|$)/i.test(response.url())) return;
        const payloads = parseGraphqlPayload(response.request().postData());
        for (const payload of payloads) {
          const operationName = normalize(payload?.operationName);
          if (/^myDropInRsvps$/i.test(operationName)) myDropInRsvpsResponses += 1;
          if (/^getDropInInfo$/i.test(operationName)) getDropInInfoResponses += 1;
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
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const cards = await collectDashboardCards(page);
    await Promise.allSettled([...pending]);

    const now = Date.now();
    const parsed = cards.map((card) => ({ ...card, parsed: parseCardDateTime(card.text, now) }));
    const upcoming = parsed
      .filter((card) => card.parsed)
      .filter((card) => card.parsed.timestamp >= now - 3 * 60 * 60 * 1_000)
      .filter((card) => card.parsed.timestamp <= now + 180 * 24 * 60 * 60 * 1_000)
      .sort((left, right) => left.parsed.timestamp - right.parsed.timestamp);

    return {
      cards,
      parsed,
      upcoming,
      myDropInRsvpsResponses,
      getDropInInfoResponses,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  try {
    const [calendarName, diagnostic] = await Promise.all([
      verifyCalendarAccess(),
      inspectDashboard(),
    ]);

    const examples = diagnostic.upcoming.slice(0, 10).map(
      (card, index) =>
        `${index + 1}. ${sanitize(card.text).slice(0, 500)} | Parsed: ${formatDenverTime(
          card.parsed.timestamp
        )}`
    );

    const message = [
      `Google calendar access: OK (${calendarName}).`,
      "Volo login: OK.",
      `Authenticated dashboard member cards found: ${diagnostic.cards.length}.`,
      `Cards with parseable date and time: ${diagnostic.parsed.filter((card) => card.parsed).length}.`,
      `Upcoming registered dashboard sessions: ${diagnostic.upcoming.length}.`,
      `myDropInRsvps responses observed: ${diagnostic.myDropInRsvpsResponses}.`,
      `getDropInInfo responses observed: ${diagnostic.getDropInInfoResponses}.`,
      examples.length
        ? `Upcoming registered session examples:\n${examples.join("\n")}`
        : "No upcoming registered dashboard cards could be parsed.",
    ].join("\n");

    // The repository is public. Logs contain counts and parsing success only.
    console.log(
      JSON.stringify(
        {
          calendarName,
          dashboardCardCount: diagnostic.cards.length,
          parseableCardCount: diagnostic.parsed.filter((card) => card.parsed).length,
          upcomingCardCount: diagnostic.upcoming.length,
          myDropInRsvpsResponses: diagnostic.myDropInRsvpsResponses,
          getDropInInfoResponses: diagnostic.getDropInInfoResponses,
          parseFieldPresence: diagnostic.parsed.slice(0, 40).map((card) => ({
            hasRouteId: Boolean(card.routeId),
            hasText: Boolean(card.text),
            hasParsedDateTime: Boolean(card.parsed),
          })),
        },
        null,
        2
      )
    );

    await notify("Volo registered dashboard diagnostic", message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    await notify(
      "Volo dashboard diagnostic failed",
      sanitize(message).slice(0, 800),
      "4",
      "calendar,warning"
    ).catch((notificationError) => {
      console.error("Could not send diagnostic failure notification:", notificationError);
    });
    process.exitCode = 1;
  }
}

await main();
