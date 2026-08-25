import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-sync.mjs";
let source = await readFile(path, "utf8");

const helperMarker = "function sessionSportKey(activity) {";
if (!source.includes(helperMarker)) {
  throw new Error("Run the RSVP GraphQL/title/location patches before the authenticated-detail patch.");
}

const helpers = `function parseAuthenticatedDetailTimeRange(rawText) {
  const text = normalize(rawText);
  const match = text.match(
    /\\b(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\s*[–—-]\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\b/i
  );
  if (!match) return null;

  const clockMinutes = (hourText, minuteText, meridiemText) => {
    let hour = Number(hourText);
    const minute = Number(minuteText || 0);
    const meridiem = normalize(meridiemText).toLowerCase();
    if (!Number.isInteger(hour) || hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
    if (hour === 12) hour = 0;
    if (meridiem === "pm") hour += 12;
    return hour * 60 + minute;
  };

  const startMinutes = clockMinutes(match[1], match[2], match[3]);
  let endMinutes = clockMinutes(match[4], match[5], match[6]);
  if (startMinutes == null || endMinutes == null) return null;
  if (endMinutes <= startMinutes) endMinutes += 24 * 60;
  const durationMinutes = endMinutes - startMinutes;
  if (durationMinutes < 10 || durationMinutes > 240) return null;
  return { startMinutes, endMinutes, durationMinutes };
}

function authenticatedVenueFromText(rawText) {
  const lines = String(rawText || "")
    .split(/\\n+/)
    .map((line) => normalize(line))
    .filter(Boolean);

  const bad = (line) =>
    !line ||
    !usableLocationValue(line) ||
    /^(?:field|court)\\s*\\d+[a-z]?$/i.test(line) ||
    /^(?:du area|team|league|host|name|color|captain)$/i.test(line) ||
    /^(?:recreational|competitive|intermediate|advanced|beginner)(?:\\s*,\\s*(?:recreational|competitive|intermediate|advanced|beginner))*$/i.test(line) ||
    /^(?:tue|wed|thu|fri|sat|sun|mon)(?:sday)?,?\\s+/i.test(line) ||
    /\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\b/i.test(line) ||
    /cancel drop-in|cancellation|no-show|support|logout/i.test(line);

  const scored = lines
    .filter((line) => !bad(line))
    .map((line) => {
      let score = 0;
      if (/\\buniversity\\b/i.test(line)) score += 130;
      if (/\\b(?:park|stadium|arena|complex|center|centre|school|academy|gym|facility|sportsplex)\\b/i.test(line)) score += 120;
      if (/\\b(?:field|court|turf)\\b/i.test(line)) score += 95;
      if (/\\b(?:club|recreation|rec center)\\b/i.test(line)) score += 75;
      if (line.includes(" - ") || line.includes(" – ") || line.includes(" — ")) score += 10;
      return { line, score };
    })
    .filter((item) => item.score >= 75)
    .sort((left, right) => right.score - left.score || right.line.length - left.line.length);

  return scored[0]?.line || "";
}

function localClockMinutes(timestamp) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])
  );
  return values.hour * 60 + values.minute;
}

async function enrichRsvpFromAuthenticatedDetails(browser, sessions) {
  const targets = sessions
    .filter((session) => session?.routeId?.startsWith("rsvp:"))
    .slice(0, 30);
  if (targets.length === 0) return;

  let page;
  try {
    page = await browser.newPage();
    await configurePage(page);

    for (const session of targets) {
      const gameId = session.routeId.slice("rsvp:".length);
      try {
        await page.goto("https://www.volosports.com/app/" + encodeURIComponent(gameId), {
          waitUntil: "domcontentloaded",
          timeout: 90_000,
        });
        await page.waitForNetworkIdle({ idleTime: 800, timeout: 12_000 }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 800));

        const detail = await page.evaluate(() => ({
          url: location.href,
          text: document.body?.innerText || "",
        }));
        if (/\\/login(?:\\/|$|\\?)/i.test(detail.url)) {
          throw new Error("Authenticated drop-in detail redirected to login.");
        }

        const venue = authenticatedVenueFromText(detail.text);
        if (venue) {
          session.location = venue;
          session.venueSource = "authenticated-app-detail";
          session.rawText = [session.rawText, "authVenue", venue].join("|");
        }

        const range = parseAuthenticatedDetailTimeRange(detail.text);
        if (range) {
          const currentStartMinutes = localClockMinutes(session.startTimestamp);
          let difference = Math.abs(range.startMinutes - currentStartMinutes);
          difference = Math.min(difference, Math.abs(range.startMinutes - (currentStartMinutes + 24 * 60)));
          if (difference <= 2) {
            session.durationMinutes = range.durationMinutes;
            session.endTimestamp = session.startTimestamp + range.durationMinutes * 60_000;
            session.timingSource = "authenticated-app-detail";
            session.rawText = [session.rawText, "authDuration", String(range.durationMinutes)].join("|");
          }
        }

        console.log(
          "RSVP_AUTH_DETAIL " +
            JSON.stringify({
              gameId: gameId.slice(0, 12),
              start: new Date(session.startTimestamp).toISOString(),
              end: new Date(session.endTimestamp).toISOString(),
              location: session.location || "",
              timingSource: session.timingSource || "",
              venueSource: session.venueSource || "",
            })
        );
      } catch (error) {
        console.log(
          "RSVP_AUTH_DETAIL_FAILED " +
            JSON.stringify({ gameId: gameId.slice(0, 12), message: error?.message || String(error) })
        );
      }
    }
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

`;

if (!source.includes("async function enrichRsvpFromAuthenticatedDetails(")) {
  source = source.replace(helperMarker, helpers + helperMarker);
}

const sessionsMarker = `    const sessions = [...cardSessions, ...rsvpSessions].sort(`;
const enrichedMarker = `    await enrichRsvpFromAuthenticatedDetails(browser, rsvpSessions);\n\n${sessionsMarker}`;
if (!source.includes("await enrichRsvpFromAuthenticatedDetails(browser, rsvpSessions);")) {
  if (!source.includes(sessionsMarker)) {
    throw new Error("Could not locate RSVP session merge block.");
  }
  source = source.replace(sessionsMarker, enrichedMarker);
}

await writeFile(path, source, "utf8");
console.log("Added authenticated exact-game Volo detail enrichment for RSVP venue and timing.");
