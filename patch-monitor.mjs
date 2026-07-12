import { readFile, writeFile } from "node:fs/promises";

const path = "monitor.mjs";
const source = await readFile(path, "utf8");

const startMarker = "function parseEventDetails(text) {";
const endMarker = "\n\nfunction stableId(match) {";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);

if (start === -1 || end === -1) {
  throw new Error("Could not locate parseEventDetails in monitor.mjs");
}

const replacement = String.raw`function parseEventDetails(text) {
  const normalized = normalizeText(text);
  const weekdayPattern =
    "(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";

  const header = new RegExp(
    \`Drop[\\s-]*In\\s+\${weekdayPattern}\\s*-\\s*Soccer\\s*-\\s*(.*?)\\s*-\\s*Drop[\\s-]*In\\s+\`,
    "i"
  ).exec(normalized);

  const day =
    header?.[1] ??
    new RegExp(\`\${weekdayPattern}\\s*-\\s*Soccer\`, "i").exec(normalized)?.[1] ??
    new RegExp(\`\\b\${weekdayPattern}\\b\`, "i").exec(normalized)?.[1] ??
    "Unknown day";

  const searchFrom = header
    ? normalized.slice(header.index + header[0].length)
    : normalized;

  // A Volo card can contain a hidden date timestamp such as 0:00am before the
  // actual visible kickoff time. Prefer the final time immediately preceding
  // the availability/price portion of the card, and ignore midnight when a
  // second time is available.
  const spotIndex = searchFrom.search(
    /\\b(?:\\d+\\s+(?:men(?:'s)?\\s+)?spots?|men(?:'s)?(?:\\s+spots?)?\\s*[:\\-]?\\s*\\d+)\\b/i
  );
  const eventSection = spotIndex >= 0 ? searchFrom.slice(0, spotIndex) : searchFrom;
  const timeMatches = [
    ...eventSection.matchAll(/\\b(\\d{1,2}:\\d{2})\\s*(am|pm)\\b/gi),
  ];
  const nonMidnightMatches = timeMatches.filter(
    (match) => normalizeTime(\`\${match[1]} \${match[2]}\`) !== "0:00am"
  );
  const timeMatch = nonMidnightMatches.at(-1) ?? timeMatches.at(-1) ?? null;
  const time = timeMatch
    ? normalizeTime(\`\${timeMatch[1]} \${timeMatch[2]}\`)
    : "Unknown time";

  let location = timeMatch
    ? normalizeText(eventSection.slice(0, timeMatch.index))
    : "";

  const neighborhood = normalizeText(header?.[2] ?? "");

  // Remove hidden date labels/timestamps and repeated card labels before
  // deriving the venue.
  location = location
    .replace(/\\b(?:today|tomorrow)\\b/gi, "")
    .replace(/\\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\s+[A-Z][a-z]{2}\\s+\\d{1,2}\\b/gi, "")
    .replace(/\\b\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?\\b/g, "")
    .replace(/\\b0:00\\s*am\\b/gi, "")
    .replace(/\\bprogram cover image\\b/gi, "")
    .replace(/\\bdrop[\\s-]*in\\b/gi, "")
    .replace(/^(?:at|in)\\s+/i, "")
    .replace(/\\s+/g, " ")
    .trim();

  if (
    neighborhood &&
    location.toLowerCase().startsWith(neighborhood.toLowerCase())
  ) {
    location = normalizeText(location.slice(neighborhood.length));
  }

  // If the card repeats its descriptive title, keep the final venue-like
  // segment. Example: "Tuesday - Soccer - Sloan's Lake - Sloan's Lake Hallack
  // Park" becomes "Hallack Park" after the neighborhood is removed.
  const dashSegments = location
    .split(/\\s+-\\s+/)
    .map((segment) => normalizeText(segment))
    .filter(Boolean);
  if (dashSegments.length > 1) {
    location = dashSegments.at(-1);
  }

  if (!location) location = "Location unavailable";

  return {
    day: titleCase(day),
    time,
    location: titleCase(location),
  };
}`;

const updated = source.slice(0, start) + replacement + source.slice(end);
await writeFile(path, updated, "utf8");
console.log("Applied current Volo parser fixes.");
