import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-sync.mjs";
let source = await readFile(path, "utf8");

function replaceBetween(text, startMarker, endMarker, replacement) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error("Could not locate start marker: " + startMarker);
  const end = text.indexOf(endMarker, start);
  if (end < 0) throw new Error("Could not locate end marker: " + endMarker);
  return text.slice(0, start) + replacement + "\n\n" + text.slice(end);
}

const startMarker = "function locationForRsvp(scalars) {";
const endMarker = "function genericRsvpActivity(value) {";

if (!source.includes(startMarker) || !source.includes(endMarker)) {
  throw new Error("Run the RSVP GraphQL and title/timing patches before the location patch.");
}

const replacement = `function usableLocationValue(value) {
  const text = normalize(value);
  if (!text || text.length < 2 || text.length > 180) return false;
  if (/^https?:\\/\\//i.test(text)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(text)) return false;
  if (/^-?\\d+(?:\\.\\d+)?(?:,\\s*-?\\d+(?:\\.\\d+)?)?$/.test(text)) return false;
  if (/^\\d{4}-\\d{2}-\\d{2}T/i.test(text)) return false;
  if (/^(?:sports?|games?|soccer|pickleball|volleyball|basketball|kickball|softball|football|dodgeball|cornhole|daily sports|volo sports|volo|drop[ -]?in|pickup)$/i.test(text)) return false;
  return true;
}

function locationCandidateScore(path, value) {
  const p = normalize(path).toLowerCase();
  const v = normalize(value);
  if (!usableLocationValue(v)) return -1;
  if (/\\b(?:id|uuid|slug|url|latitude|longitude|lat|lng)\\b/i.test(p)) return -1;

  let score = 0;
  if (/venue.*(?:name|title)|(?:name|title).*venue/i.test(p)) score += 120;
  else if (/facility.*(?:name|title)|(?:name|title).*facility/i.test(p)) score += 115;
  else if (/location.*(?:name|title)|(?:name|title).*location/i.test(p)) score += 110;
  else if (/site.*(?:name|title)|(?:name|title).*site/i.test(p)) score += 105;
  else if (/park.*(?:name|title)|(?:name|title).*park/i.test(p)) score += 100;
  else if (/field.*(?:name|title)|(?:name|title).*field/i.test(p)) score += 95;
  else if (/court.*(?:name|title)|(?:name|title).*court/i.test(p)) score += 95;
  else if (/space.*(?:name|title)|(?:name|title).*space/i.test(p)) score += 85;
  else if (/(?:venue|facility|location|site|park|field|court|space)/i.test(p)) score += 55;

  if (/(?:^|\\.)(?:name|title|label)$/i.test(p)) score += 25;
  if (/\\b(?:park|field|club|arena|center|centre|stadium|complex|school|gym|court|facility|academy|turf)\\b/i.test(v)) {
    score += 25;
  }
  if (/address|street|city|state|zip|postal/i.test(p)) score -= 35;
  return score;
}

function bestLocationCandidate(scalars, kindPattern) {
  return scalars
    .filter(({ path, value }) => kindPattern.test(path) && usableLocationValue(value))
    .map(({ path, value }) => ({ value: normalize(value), score: locationCandidateScore(path, value) }))
    .filter((item) => item.score >= 0)
    .sort((left, right) => right.score - left.score)[0]?.value || "";
}

function locationForRsvp(scalars) {
  const venue = bestLocationCandidate(
    scalars,
    /venue|facility|location|site|park|complex|arena|stadium/i
  );
  const field = bestLocationCandidate(scalars, /field|court|space|surface/i);

  if (field && venue && field.toLowerCase() !== venue.toLowerCase()) {
    return field + " — " + venue;
  }
  if (venue) return venue;
  if (field) return field;

  const fallback = scalars
    .map(({ path, value }) => ({ value: normalize(value), score: locationCandidateScore(path, value) }))
    .filter(
      (item) =>
        item.score >= 20 &&
        /\\b(?:park|field|club|arena|center|centre|stadium|complex|school|gym|court|facility|academy|turf)\\b/i.test(
          item.value
        )
    )
    .sort((left, right) => right.score - left.score)[0];

  return fallback?.value || "";
}`;

source = replaceBetween(source, startMarker, endMarker, replacement);

const timingDiagnostic = `            timingSource: session.timingSource,`;
const locationDiagnostic = `${timingDiagnostic}\n            location: session.location || "",`;
if (!source.includes('location: session.location || ""')) {
  if (!source.includes(timingDiagnostic)) {
    throw new Error("Could not locate RSVP timing diagnostic block.");
  }
  source = source.replace(timingDiagnostic, locationDiagnostic);
}

await writeFile(path, source, "utf8");
console.log("Applied source-aware Volo RSVP location extraction with generic-text rejection.");
