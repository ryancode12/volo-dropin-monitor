import { readFile, writeFile } from "node:fs/promises";

const path = "monitor.mjs";
let source = await readFile(path, "utf8");

function replaceBetween(text, startMarker, endMarker, replacement) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error("Could not locate start marker: " + startMarker);
  const end = text.indexOf(endMarker, start);
  if (end < 0) throw new Error("Could not locate end marker: " + endMarker);
  return text.slice(0, start) + replacement + text.slice(end);
}

// Volo's current Daily Sports cards use abbreviated weekday labels and time ranges
// such as "Tue" and "9/9 · 6 – 9pm". The old monitor required either a full
// weekday name or a time with minutes, causing valid drop-ins to be discarded.
const oldRelevant = `          /(?:\\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\\b|\\b\\d{1,2}:\\d{2}\\s*(?:am|pm)\\b)/i.test(\n            text\n          )`;
const newRelevant = `          /(?:\\b(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\\b|\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?\\s*[–—-]\\s*\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\b|\\b\\d{1,2}:\\d{2}\\s*(?:am|pm)\\b)/i.test(\n            text\n          )`;
if (source.includes(oldRelevant)) {
  source = source.replace(oldRelevant, newRelevant);
} else if (!source.includes("Mon(?:day)?|Tue(?:sday)?")) {
  throw new Error("Could not locate Volo card relevance date/time test.");
}

// Parse both the older individual-game cards and Volo's current Daily Sports
// program cards. Alert time is always the START of the displayed range.
const parseStart = "function parseEventDetails(text) {";
const parseEnd = "\n\nfunction stableId(match) {";
const parseReplacement = `function parseEventDetails(text) {
  const normalized = normalizeText(text);
  const dayMatch = normalized.match(
    /\\b(Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\\b/i
  );
  const dayNames = {
    mon: "Monday",
    monday: "Monday",
    tue: "Tuesday",
    tuesday: "Tuesday",
    wed: "Wednesday",
    wednesday: "Wednesday",
    thu: "Thursday",
    thursday: "Thursday",
    fri: "Friday",
    friday: "Friday",
    sat: "Saturday",
    saturday: "Saturday",
    sun: "Sunday",
    sunday: "Sunday",
  };
  const day = dayMatch ? dayNames[dayMatch[1].toLowerCase()] || titleCase(dayMatch[1]) : "Unknown day";

  const rangeMatch = normalized.match(
    /\\b(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?\\s*[–—-]\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\b/i
  );
  const singleTime = normalized.match(/\\b(\\d{1,2})(?::(\\d{2}))\\s*(am|pm)\\b/i);

  let time = "Unknown time";
  if (rangeMatch) {
    let startMeridiem = (rangeMatch[3] || "").toLowerCase();
    const endMeridiem = rangeMatch[6].toLowerCase();
    const startHour = Number(rangeMatch[1]);
    const endHour = Number(rangeMatch[4]);
    if (!startMeridiem) {
      startMeridiem = endMeridiem;
      if (endMeridiem === "pm" && startHour > endHour) startMeridiem = "am";
      if (endMeridiem === "am" && startHour > endHour) startMeridiem = "pm";
    }
    const minute = rangeMatch[2] || "00";
    time = normalizeTime(startHour + ":" + minute + startMeridiem);
  } else if (singleTime) {
    time = normalizeTime(singleTime[1] + ":" + singleTime[2] + singleTime[3]);
  }

  const dateMatch = normalized.match(/\\b\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?\\b/);
  let location = "";
  if (dateMatch) {
    let beforeDate = normalizeText(normalized.slice(0, dateMatch.index));
    const monthVenue = beforeDate.match(
      /\\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{4}\\s+(.+)$/i
    );
    if (monthVenue?.[1]) {
      location = normalizeText(monthVenue[1]);
    } else {
      const segments = beforeDate
        .split(/\\s+-\\s+/)
        .map((part) => normalizeText(part))
        .filter(Boolean);
      location = segments.at(-1) || "";
    }
  }

  location = location
    .replace(/\\b(?:today|tomorrow)\\b/gi, "")
    .replace(/^(?:at|in)\\s+/i, "")
    .replace(/\\s+/g, " ")
    .trim();
  if (!location || /^(?:soccer|drop[ -]?in|daily sports)$/i.test(location)) {
    location = "Location available on Volo";
  }

  return { day, time, location };
}`;
source = replaceBetween(source, parseStart, parseEnd, parseReplacement);

// Modern Volo detail/program pages do not always expose gender inventory using
// the exact historical labels. Explicit women-only inventory still rejects the
// listing. Otherwise, a positive Coed/Open/Men card is considered eligible when
// Volo withholds the gender-count breakdown, preventing silent false negatives.
source = source.replace(
  "async function hasMensAvailability(browser, rawUrl) {",
  "async function hasMensAvailability(browser, rawUrl, listingText = \"\") {"
);

const oldUnknownGender = `    console.log("Could not verify men's or any-gender availability: " + url);\n    return false;`;
const newUnknownGender = `    const listing = normalizeText(listingText);\n    if (/\\bwomen(?:'s)?\\b/i.test(listing) && !/\\b(?:coed|open|men(?:'s)?)\\b/i.test(listing)) {\n      console.log("Skipping explicitly women-only listing: " + url);\n      return false;\n    }\n    if (/\\b(?:coed|open|men(?:'s)?)\\b/i.test(listing)) {\n      console.log("Gender inventory labels unavailable; accepting positive eligible listing: " + url);\n      return true;\n    }\n    console.log("Could not verify gender eligibility: " + url);\n    return false;`;
if (source.includes(oldUnknownGender)) {
  source = source.replace(oldUnknownGender, newUnknownGender);
} else if (!source.includes("Gender inventory labels unavailable; accepting positive eligible listing")) {
  throw new Error("Could not locate gender-verification fallback.");
}

source = source.replace(
  "await hasMensAvailability(browser, match.url)",
  "await hasMensAvailability(browser, match.url, match.title)"
);

// Prefer exact Volo daily-sports/game links over generic navigation links.
const oldLinkScore = `              if (/\\/(?:program|league|event|drop-?in|daily)/i.test(candidate.href)) {\n                value += 8;\n              }`;
const newLinkScore = `              if (/\\/(?:d|game)\\/[0-9a-f-]{20,}/i.test(candidate.href)) {\n                value += 30;\n              } else if (/\\/(?:program|league|event|drop-?in|daily)/i.test(candidate.href)) {\n                value += 8;\n              }`;
if (source.includes(oldLinkScore)) source = source.replace(oldLinkScore, newLinkScore);

await writeFile(path, source, "utf8");
console.log("Applied current Volo card-format and eligibility compatibility fixes.");
