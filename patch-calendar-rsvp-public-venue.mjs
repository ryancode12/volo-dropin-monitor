import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-sync.mjs";
let source = await readFile(path, "utf8");

const helperMarker = "function sessionSportKey(activity) {";
if (!source.includes(helperMarker)) {
  throw new Error("Run the RSVP GraphQL/title/location patches before the public venue patch.");
}

const helpers = `function usablePublicVenueLine(value) {
  const text = normalize(value);
  if (!text || text.length < 3 || text.length > 160) return false;
  if (!usableLocationValue(text)) return false;
  if (/^(?:sports?|games?|soccer|pickleball|volleyball|basketball|kickball|softball|football|dodgeball|cornhole|daily sports|volo sports|volo|drop[ -]?in|pickup)$/i.test(text)) return false;
  if (/^(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)$/i.test(text)) return false;
  if (/\\$|\\bspots?\\b|\\bplaying\\b|\\bcloses?\\b|\\bskills?\\b|\\bcoed\\b|\\bmen(?:'s)?\\b|\\bwomen(?:'s)?\\b|\\bopen gender\\b/i.test(text)) return false;
  if (/^\\d+v\\d+$/i.test(text)) return false;
  if (/\\b\\d{1,2}\\/\\d{1,2}\\b.*\\b(?:am|pm)\\b/i.test(text)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(text)) return false;
  return /[a-z]/i.test(text);
}

function venueFromPublicVoloText(rawText) {
  const lines = String(rawText || "")
    .split(/\\n+/)
    .map((line) => normalize(line))
    .filter(Boolean);

  // Daily-sports cards normally render the venue immediately before date/time.
  for (let index = 1; index < lines.length; index += 1) {
    if (!/\\b\\d{1,2}\\/\\d{1,2}\\b.*\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?\\s*[–—-].*\\b(?:am|pm)\\b/i.test(lines[index])) continue;
    const previous = lines[index - 1];
    if (usablePublicVenueLine(previous)) return previous;
  }

  // Detail pages may explicitly label the venue/location.
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!/^(?:venue|location|facility|park|field|court|site)$/i.test(lines[index])) continue;
    if (usablePublicVenueLine(lines[index + 1])) return lines[index + 1];
  }

  // Some detail pages put a venue-like standalone line near the game details.
  const venueLike = lines.find(
    (line) =>
      usablePublicVenueLine(line) &&
      /\\b(?:park|field|club|arena|center|centre|stadium|complex|school|gym|court|facility|academy|turf)\\b/i.test(line)
  );
  return venueLike || "";
}

function parseClockMinutes(hourText, minuteText, meridiemText) {
  let hour = Number(hourText);
  const minute = Number(minuteText || 0);
  const meridiem = normalize(meridiemText).toLowerCase();
  if (!Number.isInteger(hour) || hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (hour === 12) hour = 0;
  if (meridiem === "pm") hour += 12;
  return hour * 60 + minute;
}

function dailySportWindowFromText(rawText) {
  const text = normalize(rawText);
  const match = text.match(
    /\\b(\\d{1,2})\\/(\\d{1,2})\\b\\s*·?\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?\\s*[–—-]\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\b/i
  );
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  let startMeridiem = normalize(match[5]).toLowerCase();
  const endMeridiem = normalize(match[8]).toLowerCase();
  const startHour = Number(match[3]);
  const endHour = Number(match[6]);
  if (!startMeridiem) {
    startMeridiem = endMeridiem;
    // 11 – 1pm means 11am – 1pm, not 11pm – 1pm.
    if (endMeridiem === "pm" && startHour > endHour) startMeridiem = "am";
    if (endMeridiem === "am" && startHour > endHour) startMeridiem = "pm";
  }

  const startMinutes = parseClockMinutes(match[3], match[4], startMeridiem);
  let endMinutes = parseClockMinutes(match[6], match[7], endMeridiem);
  if (startMinutes == null || endMinutes == null) return null;
  if (endMinutes <= startMinutes) endMinutes += 24 * 60;

  const venue = venueFromPublicVoloText(rawText);
  const sport = sportFromText(rawText);
  if (!venue) return null;
  return { month, day, startMinutes, endMinutes, venue, sport, text: rawText };
}

function sessionDenverParts(timestamp) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])
  );
  return {
    month: values.month,
    day: values.day,
    minutes: values.hour * 60 + values.minute,
  };
}

async function collectVoloDailySportCardTexts(page) {
  await page.evaluate(async () => {
    let previousHeight = 0;
    for (let step = 0; step < 20; step += 1) {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const height = document.body.scrollHeight;
      if (height === previousHeight && step >= 5) break;
      previousHeight = height;
    }
    window.scrollTo(0, 0);
  });

  return await page.evaluate(() => {
    const clean = (value) => String(value ?? "").replace(/\\r/g, "").trim();
    const output = [];
    const seen = new Set();

    for (const link of document.querySelectorAll('a[href*="/d/"]')) {
      let url;
      try {
        url = new URL(link.href, location.href);
      } catch {
        continue;
      }
      const match = url.pathname.match(/^\\/d\\/([0-9a-f-]{30,})/i);
      if (!match) continue;
      const gameId = match[1].toLowerCase();

      let node = link;
      let bestText = "";
      for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
        const text = clean(node.innerText || node.textContent || "");
        if (
          text.length >= 20 &&
          text.length <= 2000 &&
          /\\b\\d{1,2}\\/\\d{1,2}\\b.*\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?\\s*[–—-].*\\b(?:am|pm)\\b/i.test(text)
        ) {
          bestText = text;
          break;
        }
      }
      if (!bestText) continue;

      const identity = gameId + "|" + bestText;
      if (seen.has(identity)) continue;
      seen.add(identity);
      output.push({ gameId, text: bestText });
    }
    return output.slice(0, 500);
  });
}

function unambiguousWindowVenue(session, cards) {
  const local = sessionDenverParts(session.startTimestamp);
  const sport = sessionSportKey(session.activity);
  const matches = cards
    .map((card) => dailySportWindowFromText(card.text))
    .filter(Boolean)
    .filter((window) => window.month === local.month && window.day === local.day)
    .filter((window) => {
      const minute = local.minutes < window.startMinutes ? local.minutes + 24 * 60 : local.minutes;
      return minute >= window.startMinutes && minute <= window.endMinutes;
    })
    .filter((window) => !sport || !window.sport || window.sport === sport);

  const venues = [...new Set(matches.map((item) => item.venue).filter(usablePublicVenueLine))];
  return venues.length === 1 ? venues[0] : "";
}

async function enrichRsvpLocationsFromPublicVolo(browser, sessions) {
  const targets = sessions
    .filter((session) => session?.routeId?.startsWith("rsvp:"))
    .slice(0, 30);
  if (targets.length === 0) return;

  // Never preserve a generic value such as "sports" as a real location.
  for (const session of targets) {
    if (!usableLocationValue(session.location)) session.location = "";
    session.venueSource = session.location ? "graphql" : "";
  }

  let page;
  try {
    page = await browser.newPage();
    await configurePage(page);
    await page.goto(
      "https://www.volosports.com/discover/denver?category=daily-sports",
      { waitUntil: "domcontentloaded", timeout: 90_000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    const cards = await collectVoloDailySportCardTexts(page);
    const cardByGameId = new Map();
    for (const card of cards) {
      if (!cardByGameId.has(card.gameId)) cardByGameId.set(card.gameId, card);
    }

    // Strongest public match: the discover card has the exact RSVP game ID.
    for (const session of targets.filter((item) => !usableLocationValue(item.location))) {
      const gameId = session.routeId.slice("rsvp:".length).toLowerCase();
      const card = cardByGameId.get(gameId);
      const venue = card ? venueFromPublicVoloText(card.text) : "";
      if (venue) {
        session.location = venue;
        session.venueSource = "discover-game-id";
        session.rawText = [session.rawText, "venue", venue].join("|");
      }
    }

    // Next strongest: visit the exact game's Volo detail route.
    for (const session of targets.filter((item) => !usableLocationValue(item.location))) {
      const gameId = session.routeId.slice("rsvp:".length);
      try {
        await page.goto("https://www.volosports.com/d/" + encodeURIComponent(gameId), {
          waitUntil: "domcontentloaded",
          timeout: 90_000,
        });
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const bodyText = await page.evaluate(() => document.body?.innerText || "");
        const venue = venueFromPublicVoloText(bodyText);
        if (venue) {
          session.location = venue;
          session.venueSource = "game-detail";
          session.rawText = [session.rawText, "venue", venue].join("|");
        }
      } catch (error) {
        console.log(
          "RSVP_VENUE_DETAIL_FAILED " +
            JSON.stringify({ gameId: gameId.slice(0, 12), message: error?.message || String(error) })
        );
      }
    }

    // Final safe fallback: use the Daily Sports program window only when one unique
    // venue contains the exact registered game's local start time.
    for (const session of targets.filter((item) => !usableLocationValue(item.location))) {
      const venue = unambiguousWindowVenue(session, cards);
      if (venue) {
        session.location = venue;
        session.venueSource = "unique-program-window";
        session.rawText = [session.rawText, "venue", venue].join("|");
      }
    }

    // Never pass stale generic text forward to Google Calendar.
    for (const session of targets) {
      if (!usableLocationValue(session.location)) session.location = "";
    }

    console.log(
      "RSVP_VENUE " +
        JSON.stringify(
          targets.map((session) => ({
            gameId: session.routeId.slice(5, 17),
            start: new Date(session.startTimestamp).toISOString(),
            location: session.location || "",
            source: session.venueSource || "unresolved",
          }))
        )
    );
  } catch (error) {
    console.log("RSVP_VENUE_ENRICHMENT_FAILED " + (error?.message || String(error)));
    for (const session of targets) {
      if (!usableLocationValue(session.location)) session.location = "";
    }
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

`;

if (!source.includes("async function enrichRsvpLocationsFromPublicVolo(")) {
  source = source.replace(helperMarker, helpers + helperMarker);
}

const sessionsMarker = `    const sessions = [...cardSessions, ...rsvpSessions].sort(`;
const enrichedSessionsMarker = `    await enrichRsvpLocationsFromPublicVolo(browser, rsvpSessions);\n\n${sessionsMarker}`;
if (!source.includes("await enrichRsvpLocationsFromPublicVolo(browser, rsvpSessions);")) {
  if (!source.includes(sessionsMarker)) {
    throw new Error("Could not locate RSVP session merge block.");
  }
  source = source.replace(sessionsMarker, enrichedSessionsMarker);
}

await writeFile(path, source, "utf8");
console.log("Added multi-source, generic-safe Volo venue enrichment for RSVP calendar events.");
