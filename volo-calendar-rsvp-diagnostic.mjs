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

function collectSchema(value, output, path = "data", depth = 0) {
  if (depth > 12 || value == null) return;

  if (Array.isArray(value)) {
    const identity = `${path}[]|Array`;
    if (!output.some((item) => item.identity === identity)) {
      output.push({ identity, path: `${path}[]`, typename: "Array", keys: [], length: value.length });
    }
    for (const item of value.slice(0, 20)) {
      collectSchema(item, output, `${path}[]`, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") return;

  const keys = Object.keys(value).slice(0, 50);
  const typename = typeof value.__typename === "string" ? normalize(value.__typename) : "Object";
  const identity = `${path}|${typename}|${keys.join(",")}`;
  if (!output.some((item) => item.identity === identity)) {
    output.push({ identity, path, typename, keys });
  }

  for (const key of Object.keys(value).slice(0, 120)) {
    collectSchema(value[key], output, `${path}.${key}`, depth + 1);
  }
}

function isPrimitive(value) {
  return ["string", "number", "boolean"].includes(typeof value);
}

function deepFindByKeys(value, keys, depth = 0, seen = new Set()) {
  if (depth > 6 || value == null || typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);

  if (!Array.isArray(value)) {
    for (const key of keys) {
      if (isPrimitive(value[key])) return normalize(value[key]);
    }
  }

  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children.slice(0, 120)) {
    const found = deepFindByKeys(child, keys, depth + 1, seen);
    if (found) return found;
  }
  return "";
}

function parseTimestamp(value) {
  if (value === "") return null;
  if (typeof value === "number") {
    const ms = value < 10_000_000_000 ? value * 1_000 : value;
    return Number.isFinite(ms) ? ms : null;
  }
  const text = normalize(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function candidateFromObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const serialized = JSON.stringify(value);
  if (!/pickup|drop.?in|soccer|pickleball|volleyball|rsvp/i.test(serialized)) return null;

  const title = deepFindByKeys(value, [
    "display_name",
    "displayName",
    "event_name",
    "eventName",
    "game_name",
    "gameName",
    "program_name",
    "programName",
    "name",
    "title",
  ]);
  const startRaw = deepFindByKeys(value, [
    "start_datetime",
    "startDateTime",
    "start_date",
    "startDate",
    "starts_at",
    "startsAt",
    "start_time",
    "startTime",
    "date",
  ]);
  const startTimestamp = parseTimestamp(startRaw);
  if (!title || startTimestamp === null) return null;

  const endRaw = deepFindByKeys(value, [
    "end_datetime",
    "endDateTime",
    "end_date",
    "endDate",
    "ends_at",
    "endsAt",
    "end_time",
    "endTime",
  ]);

  const location = deepFindByKeys(value, [
    "venue_name",
    "venueName",
    "facility_name",
    "facilityName",
    "location_name",
    "locationName",
    "address",
  ]);
  const status = deepFindByKeys(value, [
    "rsvp_status",
    "rsvpStatus",
    "registration_status",
    "registrationStatus",
    "status",
  ]);
  const id = deepFindByKeys(value, [
    "rsvp_id",
    "rsvpId",
    "registration_id",
    "registrationId",
    "drop_in_id",
    "dropInId",
    "_id",
    "id",
  ]);

  return {
    path,
    id,
    title,
    startRaw,
    startTimestamp,
    endRaw,
    endTimestamp: parseTimestamp(endRaw),
    location,
    status,
    keys: Object.keys(value).slice(0, 35),
  };
}

function collectEventCandidates(value, output, path = "data", depth = 0) {
  if (depth > 10 || value == null) return;

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 250)) {
      collectEventCandidates(item, output, `${path}[]`, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") return;

  const candidate = candidateFromObject(value, path);
  if (candidate) {
    const identity = `${candidate.title}|${candidate.startTimestamp}|${candidate.location}`;
    if (!output.some((item) => item.identity === identity)) {
      output.push({ identity, ...candidate });
    }
  }

  for (const [key, child] of Object.entries(value).slice(0, 120)) {
    collectEventCandidates(child, output, `${path}.${key}`, depth + 1);
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

async function inspectRsvps() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const captures = [];
  const pending = new Set();

  try {
    const page = await browser.newPage();
    await configurePage(page);

    page.on("response", (response) => {
      const task = (async () => {
        const url = response.url();
        if (!/\/hapi\/v1\/graphql(?:\?|$)/i.test(url)) return;

        const payloads = parseGraphqlPayload(response.request().postData());
        if (!payloads.some((payload) => /^myDropInRsvps$/i.test(normalize(payload?.operationName)))) {
          return;
        }

        let responseJson;
        try {
          responseJson = await response.json();
        } catch {
          return;
        }

        const responseItems = Array.isArray(responseJson) ? responseJson : [responseJson];
        for (let index = 0; index < payloads.length; index += 1) {
          const payload = payloads[index] || {};
          if (!/^myDropInRsvps$/i.test(normalize(payload.operationName))) continue;

          const responseItem = responseItems[index] ?? responseItems[0];
          const schema = [];
          const candidates = [];
          collectSchema(responseItem, schema);
          collectEventCandidates(responseItem, candidates);

          captures.push({
            variableKeys:
              payload.variables && typeof payload.variables === "object"
                ? Object.keys(payload.variables).sort().slice(0, 30)
                : [],
            schema,
            candidates,
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
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await Promise.allSettled([...pending]);

    if (captures.length === 0) {
      throw new Error("The dashboard did not return a myDropInRsvps GraphQL response.");
    }

    const schemas = [];
    const candidates = [];
    for (const capture of captures) {
      for (const item of capture.schema) {
        if (!schemas.some((existing) => existing.identity === item.identity)) schemas.push(item);
      }
      for (const item of capture.candidates) {
        if (!candidates.some((existing) => existing.identity === item.identity)) candidates.push(item);
      }
    }

    return {
      captureCount: captures.length,
      variableKeys: [...new Set(captures.flatMap((capture) => capture.variableKeys))],
      schema: schemas,
      candidates,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  try {
    const [calendarName, diagnostic] = await Promise.all([
      verifyCalendarAccess(),
      inspectRsvps(),
    ]);

    const now = Date.now() - 6 * 60 * 60 * 1_000;
    const upcoming = diagnostic.candidates
      .filter((item) => item.startTimestamp >= now)
      .filter((item) => !/cancel|withdraw|refund|deleted|inactive/i.test(item.status || ""))
      .sort((a, b) => a.startTimestamp - b.startTimestamp);

    const examples = upcoming.slice(0, 8).map((item, index) => {
      const parts = [
        `${index + 1}. ${item.title}`,
        formatDenverTime(item.startTimestamp),
        item.location,
        item.status ? `status: ${item.status}` : "",
      ].filter(Boolean);
      return parts.join(" | ");
    });

    const relevantSchema = diagnostic.schema
      .filter((item) =>
        /rsvp|drop|pickup|game|program|event|start|date|venue|location|team/i.test(
          `${item.path} ${item.typename} ${item.keys.join(" ")}`
        )
      )
      .slice(0, 12);

    const message = [
      `Google calendar access: OK (${calendarName}).`,
      "Volo login: OK.",
      `myDropInRsvps responses captured: ${diagnostic.captureCount}.`,
      `RSVP event candidates extracted: ${diagnostic.candidates.length}.`,
      `Upcoming active RSVP candidates: ${upcoming.length}.`,
      examples.length
        ? `Upcoming RSVP examples:\n${examples.join("\n")}`
        : "No upcoming RSVP event candidates could be extracted.",
    ].join("\n");

    // This repository is public. Logs contain schema and field-presence data only.
    console.log(
      JSON.stringify(
        {
          calendarName,
          operation: "myDropInRsvps",
          captureCount: diagnostic.captureCount,
          variableKeys: diagnostic.variableKeys,
          totalCandidateCount: diagnostic.candidates.length,
          upcomingCandidateCount: upcoming.length,
          candidateFieldPresence: diagnostic.candidates.slice(0, 20).map((item) => ({
            path: item.path,
            hasId: Boolean(item.id),
            hasTitle: Boolean(item.title),
            hasStart: Boolean(item.startTimestamp),
            hasEnd: Boolean(item.endTimestamp),
            hasLocation: Boolean(item.location),
            hasStatus: Boolean(item.status),
            keys: item.keys,
          })),
          relevantSchema,
        },
        null,
        2
      )
    );

    await notify("Volo RSVP targeting diagnostic", sanitize(message));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    await notify(
      "Volo RSVP diagnostic failed",
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
