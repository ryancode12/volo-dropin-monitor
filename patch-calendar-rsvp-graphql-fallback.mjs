import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-sync.mjs";
let source = await readFile(path, "utf8");

const collectMarker = "async function collectDashboardCards(page) {";
if (!source.includes("function rsvpSessionFromRegistrant(")) {
  if (!source.includes(collectMarker)) {
    throw new Error("Could not locate dashboard card collector.");
  }

  const helpers = `function parseGraphqlPayload(postData) {
  if (!postData) return [];
  try {
    const parsed = JSON.parse(postData);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function flattenScalars(value, path = "data", output = [], depth = 0) {
  if (value == null || depth > 10) return output;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) {
      flattenScalars(item, path + "[]", output, depth + 1);
    }
    return output;
  }
  if (typeof value !== "object") {
    output.push({ path, value: String(value) });
    return output;
  }
  for (const [key, child] of Object.entries(value).slice(0, 150)) {
    flattenScalars(child, path + "." + key, output, depth + 1);
  }
  return output;
}

function findDropInGameObject(value, depth = 0) {
  if (value == null || depth > 10) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDropInGameObject(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;

  const start = value.start_time ?? value.startTime;
  const id = value._id ?? value.id;
  if (id && start && Number.isFinite(Date.parse(String(start)))) return value;

  for (const child of Object.values(value)) {
    const found = findDropInGameObject(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function firstScalar(scalars, pathPattern, valuePattern = null) {
  const item = scalars.find(({ path, value }) =>
    pathPattern.test(path) && (!valuePattern || valuePattern.test(value))
  );
  return item ? normalize(item.value) : "";
}

function sportFromScalars(scalars) {
  const named = firstScalar(scalars, /(?:^|\.)(?:sport|sport_name|sportName)(?:\.|$)/i);
  const combined = [named, ...scalars.map((item) => item.value)].join(" ");
  if (/\bsoccer\b/i.test(combined)) return "soccer";
  if (/\bpickleball\b/i.test(combined)) return "pickleball";
  if (/\bvolleyball\b/i.test(combined)) return "volleyball";
  if (/\bbasketball\b/i.test(combined)) return "basketball";
  if (/\bkickball\b/i.test(combined)) return "kickball";
  if (/\bsoftball\b/i.test(combined)) return "softball";
  if (/\bfootball\b/i.test(combined)) return "football";
  if (/\bdodgeball\b/i.test(combined)) return "dodgeball";
  if (/\bcornhole\b/i.test(combined)) return "cornhole";
  return "";
}

function activityForRsvp(sport, scalars) {
  if (sport === "soccer") return "Soccer Drop-In";
  if (sport === "pickleball") return "Pickleball Pickup";
  if (sport) return sport.charAt(0).toUpperCase() + sport.slice(1) + " Drop-In";

  const candidate = firstScalar(
    scalars,
    /(?:activity|program|league|event|drop.?in).*(?:name|title)|(?:name|title).*(?:activity|program|league|event|drop.?in)/i
  );
  return candidate || "Volo Drop-In";
}

function locationForRsvp(scalars) {
  const venue =
    firstScalar(scalars, /(?:venue|facility|site).*(?:name|title)/i) ||
    firstScalar(scalars, /(?:location).*(?:name|title)/i);
  const field = firstScalar(scalars, /field.*(?:name|title)/i);
  if (field && venue && field.toLowerCase() !== venue.toLowerCase()) return field + " — " + venue;
  return field || venue || "";
}

function rsvpSessionFromRegistrant(registrant, infoResponses, now = Date.now()) {
  const game = registrant?.gameByDropInGame || findDropInGameObject(registrant);
  if (!game) return null;

  const gameId = normalize(game._id ?? game.id);
  const startTimestamp = Date.parse(String(game.start_time ?? game.startTime ?? ""));
  if (!gameId || !Number.isFinite(startTimestamp)) return null;
  if (startTimestamp < now - 3 * 60 * 60 * 1_000) return null;
  if (startTimestamp > now + 180 * 24 * 60 * 60 * 1_000) return null;

  const matchingInfo = infoResponses.find((value) => {
    try {
      return JSON.stringify(value).includes(gameId);
    } catch {
      return false;
    }
  });
  const scalars = flattenScalars([registrant, matchingInfo].filter(Boolean));
  const sport = sportFromScalars(scalars);
  const activity = activityForRsvp(sport, scalars);
  const location = locationForRsvp(scalars);
  const durationMinutes = durationMinutesForActivity(activity);

  return {
    routeId: "rsvp:" + gameId,
    rawText: ["rsvp", gameId, activity, location, String(startTimestamp)].join("|"),
    teamName: "",
    activity,
    location,
    startTimestamp,
    endTimestamp: startTimestamp + durationMinutes * 60 * 1_000,
    durationMinutes,
    url: DASHBOARD_URL,
    sourceKind: "rsvp-graphql",
  };
}

function sessionSportKey(activity) {
  const text = normalize(activity).toLowerCase();
  for (const sport of ["soccer", "pickleball", "volleyball", "basketball", "kickball", "softball", "football", "dodgeball", "cornhole"]) {
    if (text.includes(sport)) return sport;
  }
  return text;
}

`;

  source = source.replace(collectMarker, helpers + collectMarker);
}

const browserMarker = `  const browser = await puppeteer.launch({`;
const captureSetup = `  const rsvpRegistrants = [];
  const dropInInfoResponses = [];
  const graphqlPending = new Set();
  let rsvpCaptureSucceeded = false;

`;
if (!source.includes("const rsvpRegistrants = [];")) {
  const loadStart = source.indexOf("async function loadUpcomingSessions() {");
  const browserStart = source.indexOf(browserMarker, loadStart);
  if (loadStart < 0 || browserStart < 0) {
    throw new Error("Could not locate registered-session browser launch.");
  }
  source = source.slice(0, browserStart) + captureSetup + source.slice(browserStart);
}

const pageSetupMarker = `    const page = await browser.newPage();
    await configurePage(page);`;
const responseCapture = `    const page = await browser.newPage();
    await configurePage(page);

    page.on("response", (response) => {
      const task = (async () => {
        if (!/\\/hapi\\/v1\\/graphql(?:\\?|$)/i.test(response.url())) return;
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
          const responseItem = responseItems[index] ?? responseItems[0];
          if (/^myDropInRsvps$/i.test(operationName)) {
            rsvpCaptureSucceeded = true;
            const registrants = responseItem?.data?.data?.registrants;
            if (Array.isArray(registrants)) rsvpRegistrants.push(...registrants);
          } else if (/^getDropInInfo$/i.test(operationName)) {
            dropInInfoResponses.push(responseItem);
          }
        }
      })()
        .catch(() => {})
        .finally(() => graphqlPending.delete(task));
      graphqlPending.add(task);
    });`;
if (!source.includes("rsvpCaptureSucceeded = true;")) {
  if (!source.includes(pageSetupMarker)) {
    throw new Error("Could not locate registered-session page setup.");
  }
  source = source.replace(pageSetupMarker, responseCapture);
}

const oldSessionBlock = `    const cards = await collectDashboardCards(page);
    const now = Date.now();
    const sessions = cards
      .map((card) => parseCardDetails(card, now))
      .filter(Boolean)
      .filter((session) => session.startTimestamp >= now - 3 * 60 * 60 * 1_000)
      .filter((session) => session.startTimestamp <= now + 180 * 24 * 60 * 60 * 1_000)
      .sort((left, right) => left.startTimestamp - right.startTimestamp);

    return { cardCount: cards.length, sessions };`;
const newSessionBlock = `    await Promise.allSettled([...graphqlPending]);
    const cards = await collectDashboardCards(page);
    const now = Date.now();
    const cardSessions = cards
      .map((card) => parseCardDetails(card, now))
      .filter(Boolean)
      .filter((session) => session.startTimestamp >= now - 3 * 60 * 60 * 1_000)
      .filter((session) => session.startTimestamp <= now + 180 * 24 * 60 * 60 * 1_000);

    const existingKeys = new Set(
      cardSessions.map(
        (session) => Math.round(session.startTimestamp / 60_000) + "|" + sessionSportKey(session.activity)
      )
    );
    const rsvpSessions = [];
    const seenRsvpIds = new Set();
    for (const registrant of rsvpRegistrants) {
      const session = rsvpSessionFromRegistrant(registrant, dropInInfoResponses, now);
      if (!session || seenRsvpIds.has(session.routeId)) continue;
      seenRsvpIds.add(session.routeId);
      const key = Math.round(session.startTimestamp / 60_000) + "|" + sessionSportKey(session.activity);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      rsvpSessions.push(session);
    }

    const sessions = [...cardSessions, ...rsvpSessions].sort(
      (left, right) => left.startTimestamp - right.startTimestamp
    );

    return {
      cardCount: cards.length,
      sessions,
      rsvpCaptureSucceeded,
      rsvpRegistrantCount: rsvpRegistrants.length,
      rsvpFallbackCount: rsvpSessions.length,
    };`;
if (!source.includes("rsvpFallbackCount: rsvpSessions.length")) {
  if (!source.includes(oldSessionBlock)) {
    throw new Error("Could not locate registered-session aggregation block.");
  }
  source = source.replace(oldSessionBlock, newSessionBlock);
}

source = source.replace(
  "async function syncSessions(sessions) {",
  "async function syncSessions(sessions, options = {}) {"
);

const missingLoopMarker = `    const routeId = privateProperties.voloRouteId;
    if (!routeId || presentRouteIds.has(routeId)) continue;`;
const sourceAwareMissing = `    const routeId = privateProperties.voloRouteId;
    if (!routeId || presentRouteIds.has(routeId)) continue;
    if (routeId.startsWith("rsvp:") && options.rsvpCaptureSucceeded !== true) continue;`;
if (!source.includes('routeId.startsWith("rsvp:")')) {
  if (!source.includes(missingLoopMarker)) {
    throw new Error("Could not locate safe-deletion missing-event guard.");
  }
  source = source.replace(missingLoopMarker, sourceAwareMissing);
}

source = source.replace(
  "    const result = await syncSessions(dashboard.sessions);",
  "    const result = await syncSessions(dashboard.sessions, { rsvpCaptureSucceeded: dashboard.rsvpCaptureSucceeded });"
);

const cardZeroGuard = `    if (dashboard.cardCount === 0) {
      throw new Error("Volo login succeeded, but no authenticated dashboard member cards were found.");
    }`;
const authoritativeGuard = `    if (dashboard.cardCount === 0 && dashboard.rsvpCaptureSucceeded !== true) {
      throw new Error("Volo login succeeded, but neither dashboard member cards nor myDropInRsvps data were available.");
    }`;
if (source.includes(cardZeroGuard)) {
  source = source.replace(cardZeroGuard, authoritativeGuard);
}

const logMarker = `          upcomingSessionCount: dashboard.sessions.length,`;
const expandedLog = `${logMarker}
          rsvpCaptureSucceeded: dashboard.rsvpCaptureSucceeded === true,
          rsvpRegistrantCount: dashboard.rsvpRegistrantCount || 0,
          rsvpFallbackCount: dashboard.rsvpFallbackCount || 0,`;
if (!source.includes("rsvpFallbackCount: dashboard.rsvpFallbackCount")) {
  if (!source.includes(logMarker)) {
    throw new Error("Could not locate calendar sync diagnostic JSON.");
  }
  source = source.replace(logMarker, expandedLog);
}

await writeFile(path, source, "utf8");
console.log("Added authoritative myDropInRsvps GraphQL fallback for registered daily-sports calendar sync.");
