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
  if (!response.ok) throw new Error(`Google Calendar access failed with HTTP ${response.status}`);
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
    const controls = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')];
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

function parseTimestamp(value) {
  if (typeof value === "number") {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const timestamp = Date.parse(normalize(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function extractRsvps(value, output, depth = 0) {
  if (depth > 10 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 300)) extractRsvps(item, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const game = value.gameByDropInGame;
  if (game && typeof game === "object") {
    const registrantId = normalize(value._id || value.id);
    const gameId = normalize(game._id || game.id);
    const startRaw = game.start_time ?? game.startTime ?? game.start_date ?? game.startDate;
    const startTimestamp = parseTimestamp(startRaw);
    if (registrantId && gameId && startTimestamp !== null) {
      const identity = `${registrantId}|${gameId}|${startTimestamp}`;
      if (!output.some((item) => item.identity === identity)) {
        output.push({ identity, registrantId, gameId, startRaw, startTimestamp });
      }
    }
  }

  for (const child of Object.values(value).slice(0, 120)) {
    extractRsvps(child, output, depth + 1);
  }
}

function collectSchema(value, output, path = "data", depth = 0) {
  if (depth > 12 || value == null) return;
  if (Array.isArray(value)) {
    const identity = `${path}[]|Array`;
    if (!output.some((item) => item.identity === identity)) {
      output.push({ identity, path: `${path}[]`, typename: "Array", keys: [], length: value.length });
    }
    for (const item of value.slice(0, 20)) collectSchema(item, output, `${path}[]`, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const keys = Object.keys(value).slice(0, 50);
  const typename = typeof value.__typename === "string" ? normalize(value.__typename) : "Object";
  const identity = `${path}|${typename}|${keys.join(",")}`;
  if (!output.some((item) => item.identity === identity)) {
    output.push({ identity, path, typename, keys });
  }
  for (const [key, child] of Object.entries(value).slice(0, 120)) {
    collectSchema(child, output, `${path}.${key}`, depth + 1);
  }
}

async function collectMemberLinks(page) {
  return await page.evaluate(() => {
    const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll('a[href*="/app/member/"]')]
      .map((link) => {
        const match = link.href.match(/\/app\/member\/([^/?#]+)/i);
        return {
          registrantId: match?.[1] || "",
          text: clean(link.innerText || link.textContent),
          href: link.href,
        };
      })
      .filter((item) => item.registrantId && item.text)
      .slice(0, 200);
  });
}

async function inspect() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const rsvps = [];
  const detailCaptures = [];
  const pending = new Set();
  let stage = "login";

  try {
    const page = await browser.newPage();
    await configurePage(page);

    page.on("response", (response) => {
      const responseStage = stage;
      const task = (async () => {
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
          const payload = payloads[index] || {};
          const operationName = normalize(payload.operationName);
          const item = responseItems[index] ?? responseItems[0];
          if (/^myDropInRsvps$/i.test(operationName)) {
            extractRsvps(item, rsvps);
          } else if (/^getDropInInfo$/i.test(operationName)) {
            const schema = [];
            collectSchema(item, schema);
            detailCaptures.push({ stage: responseStage, schema });
          }
        }
      })()
        .catch(() => {})
        .finally(() => pending.delete(task));
      pending.add(task);
    });

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => {});
    await submitLogin(page);

    stage = "dashboard";
    if (!/\/app\/dashboard(?:\/|$|\?)/i.test(page.url())) {
      await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 25_000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await Promise.allSettled([...pending]);

    const memberLinks = await collectMemberLinks(page);
    const now = Date.now() - 6 * 60 * 60 * 1_000;
    const upcoming = rsvps
      .filter((item) => item.startTimestamp >= now)
      .sort((a, b) => a.startTimestamp - b.startTimestamp)
      .slice(0, 15);

    const details = [];
    for (const rsvp of upcoming) {
      const link = memberLinks.find((item) => item.registrantId === rsvp.registrantId);
      stage = `member:${rsvp.registrantId}`;
      await page
        .goto(`https://www.volosports.com/app/member/${encodeURIComponent(rsvp.registrantId)}`, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        })
        .catch(() => null);
      await page.waitForNetworkIdle({ idleTime: 750, timeout: 15_000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await Promise.allSettled([...pending]);

      const pageText = await page.evaluate(() =>
        String(document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 1_200)
      );
      const matchingCapture = [...detailCaptures].reverse().find((item) => item.stage === stage);
      details.push({
        ...rsvp,
        dashboardText: link?.text || "",
        pageText,
        schema: matchingCapture?.schema || [],
      });
    }

    return { rsvps, upcoming, memberLinks, details, detailCaptures };
  } finally {
    await browser.close();
  }
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
    const [calendarName, diagnostic] = await Promise.all([verifyCalendarAccess(), inspect()]);

    const examples = diagnostic.details.slice(0, 6).map((item, index) => {
      const label = item.dashboardText || item.pageText || "Registered Volo session";
      return `${index + 1}. ${sanitize(label).slice(0, 420)} | ${formatDenverTime(item.startTimestamp)}`;
    });

    const schemaLines = diagnostic.details
      .flatMap((detail) => detail.schema)
      .filter((item) =>
        /drop|game|program|event|start|end|date|time|venue|location|facility|address|sport|status/i.test(
          `${item.path} ${item.typename} ${item.keys.join(" ")}`
        )
      )
      .filter(
        (item, index, array) =>
          array.findIndex(
            (other) =>
              other.path === item.path &&
              other.typename === item.typename &&
              other.keys.join(",") === item.keys.join(",")
          ) === index
      )
      .slice(0, 14)
      .map(
        (item, index) =>
          `${index + 1}. ${item.path} [${item.typename}]\nkeys: ${item.keys.join(", ") || `(array length ${item.length ?? 0})`}`
      );

    const message = [
      `Google calendar access: OK (${calendarName}).`,
      "Volo login: OK.",
      `myDropInRsvps registrations found: ${diagnostic.rsvps.length}.`,
      `Upcoming registrations found: ${diagnostic.upcoming.length}.`,
      `Dashboard member links found: ${diagnostic.memberLinks.length}.`,
      `Member detail pages inspected: ${diagnostic.details.length}.`,
      `getDropInInfo responses captured: ${diagnostic.detailCaptures.length}.`,
      examples.length ? `Matched upcoming registrations:\n${examples.join("\n")}` : "No upcoming registrations were matched.",
      schemaLines.length
        ? `getDropInInfo response structure:\n${schemaLines.join("\n\n")}`
        : "No getDropInInfo response schema was captured.",
    ].join("\n");

    console.log(
      JSON.stringify(
        {
          calendarName,
          rsvpCount: diagnostic.rsvps.length,
          upcomingCount: diagnostic.upcoming.length,
          memberLinkCount: diagnostic.memberLinks.length,
          detailPageCount: diagnostic.details.length,
          getDropInInfoCaptureCount: diagnostic.detailCaptures.length,
          matchedFieldPresence: diagnostic.details.map((item) => ({
            hasDashboardText: Boolean(item.dashboardText),
            hasPageText: Boolean(item.pageText),
            getDropInInfoSchemaNodes: item.schema.length,
          })),
        },
        null,
        2
      )
    );

    await notify("Volo RSVP detail diagnostic", message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    await notify(
      "Volo RSVP detail diagnostic failed",
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