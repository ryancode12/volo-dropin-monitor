import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-sync.mjs";
let source = await readFile(path, "utf8");

const helperMarker = "function sessionSportKey(activity) {";
if (!source.includes(helperMarker)) {
  throw new Error("Run the RSVP GraphQL/title/location patches before the public venue patch.");
}

const helpers = `function usablePublicVenueLine(value) {
  const text = normalize(value);
  if (!text || text.length < 3 || text.length > 140) return false;
  if (/^(?:sports?|games?|soccer|pickleball|volleyball|basketball|kickball|softball|football|dodgeball|cornhole|daily sports|volo sports|volo|drop[ -]?in|pickup)$/i.test(text)) return false;
  if (/^(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)$/i.test(text)) return false;
  if (/\\b(?:soccer|drop[ -]?in|pickup)\\b/i.test(text)) return false;
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

  // Volo daily-sports cards render the venue immediately before their date/time row.
  for (let index = 1; index < lines.length; index += 1) {
    if (!/\\b\\d{1,2}\\/\\d{1,2}\\b.*\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\b/i.test(lines[index])) continue;
    const previous = lines[index - 1];
    if (usablePublicVenueLine(previous)) return previous;
  }

  // Detail pages may explicitly label the venue/location instead.
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!/^(?:venue|location|facility|field|court)$/i.test(lines[index])) continue;
    if (usablePublicVenueLine(lines[index + 1])) return lines[index + 1];
  }

  return "";
}

async function collectVoloDailySportCardTexts(page) {
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
      if (seen.has(gameId)) continue;

      let node = link;
      let bestText = "";
      for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
        const text = clean(node.innerText || node.textContent || "");
        if (
          text.length >= 20 &&
          text.length <= 1600 &&
          /\\b\\d{1,2}\\/\\d{1,2}\\b.*\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\b/i.test(text)
        ) {
          bestText = text;
          break;
        }
      }

      if (!bestText) continue;
      seen.add(gameId);
      output.push({ gameId, text: bestText });
    }

    return output;
  });
}

async function enrichRsvpLocationsFromPublicVolo(browser, sessions) {
  const targets = sessions
    .filter((session) => session?.routeId?.startsWith("rsvp:"))
    .slice(0, 12);
  if (targets.length === 0) return;

  let page;
  try {
    page = await browser.newPage();
    await configurePage(page);
    await page.goto(
      "https://www.volosports.com/discover/denver?category=daily-sports&sports=soccer",
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const cards = await collectVoloDailySportCardTexts(page);
    const cardByGameId = new Map(cards.map((card) => [card.gameId, card]));

    for (const session of targets) {
      const gameId = session.routeId.slice("rsvp:".length).toLowerCase();
      const card = cardByGameId.get(gameId);
      const venue = card ? venueFromPublicVoloText(card.text) : "";
      if (venue) {
        session.location = venue;
        session.rawText = [session.rawText, "venue", venue].join("|");
      }
    }

    // Some registered games may not be in the currently rendered discover list.
    // For only those still missing a real venue, read their own /d/<gameId> page.
    for (const session of targets.filter((item) => !usableLocationValue(item.location))) {
      const gameId = session.routeId.slice("rsvp:".length);
      try {
        await page.goto("https://www.volosports.com/d/" + encodeURIComponent(gameId), {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        const bodyText = await page.evaluate(() => document.body?.innerText || "");
        const venue = venueFromPublicVoloText(bodyText);
        if (venue) {
          session.location = venue;
          session.rawText = [session.rawText, "venue", venue].join("|");
        }
      } catch (error) {
        console.log(
          "RSVP_VENUE_DETAIL_FAILED " +
            JSON.stringify({ gameId: gameId.slice(0, 12), message: error?.message || String(error) })
        );
      }
    }

    console.log(
      "RSVP_VENUE " +
        JSON.stringify(
          targets.map((session) => ({
            gameId: session.routeId.slice(5, 17),
            start: new Date(session.startTimestamp).toISOString(),
            location: usableLocationValue(session.location) ? session.location : "",
          }))
        )
    );
  } catch (error) {
    console.log("RSVP_VENUE_ENRICHMENT_FAILED " + (error?.message || String(error)));
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
console.log("Added authoritative public Volo venue enrichment for RSVP calendar events.");
