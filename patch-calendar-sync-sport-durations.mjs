import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-sync.mjs";
let source = await readFile(path, "utf8");

const oldConstant = `const DEFAULT_DURATION_MINUTES = 90;`;
const newConstants = `const SOCCER_DURATION_MINUTES = 45;
const PICKLEBALL_DURATION_MINUTES = 90;
const DEFAULT_DURATION_MINUTES = 90;`;

if (!source.includes(newConstants)) {
  if (!source.includes(oldConstant)) {
    throw new Error("Could not locate the calendar duration constant.");
  }
  source = source.replace(oldConstant, newConstants);
}

const detailsMarker = `function parseCardDetails(card, now = Date.now()) {`;
const durationHelper = `function durationMinutesForActivity(activity) {
  if (/\\bsoccer\\b/i.test(activity)) return SOCCER_DURATION_MINUTES;
  if (/\\bpickleball\\b/i.test(activity)) return PICKLEBALL_DURATION_MINUTES;
  return DEFAULT_DURATION_MINUTES;
}

`;

if (!source.includes("function durationMinutesForActivity(")) {
  if (!source.includes(detailsMarker)) {
    throw new Error("Could not locate the calendar card parser.");
  }
  source = source.replace(detailsMarker, durationHelper + detailsMarker);
}

const oldEndCalculation = `  const startTimestamp = parsedDate.timestamp;
  const endTimestamp = startTimestamp + DEFAULT_DURATION_MINUTES * 60 * 1_000;`;
const newEndCalculation = `  const startTimestamp = parsedDate.timestamp;
  const durationMinutes = durationMinutesForActivity(activity);
  const endTimestamp = startTimestamp + durationMinutes * 60 * 1_000;`;

if (!source.includes(newEndCalculation)) {
  if (!source.includes(oldEndCalculation)) {
    throw new Error("Could not locate the calendar event end-time calculation.");
  }
  source = source.replace(oldEndCalculation, newEndCalculation);
}

const oldReturnFields = `    startTimestamp,
    endTimestamp,
    url,`;
const newReturnFields = `    startTimestamp,
    endTimestamp,
    durationMinutes,
    url,`;

if (!source.includes(newReturnFields)) {
  if (!source.includes(oldReturnFields)) {
    throw new Error("Could not locate the parsed calendar session fields.");
  }
  source = source.replace(oldReturnFields, newReturnFields);
}

const oldDurationProperty = `        voloDurationMinutes: String(DEFAULT_DURATION_MINUTES),`;
const newDurationProperty = `        voloDurationMinutes: String(session.durationMinutes),`;

if (!source.includes(newDurationProperty)) {
  if (!source.includes(oldDurationProperty)) {
    throw new Error("Could not locate the calendar duration metadata field.");
  }
  source = source.replace(oldDurationProperty, newDurationProperty);
}

const oldExampleSuffix = `          )}\${action.session.location ? \` | \${action.session.location}\` : ""}`;
const newExampleSuffix = `          )} | \${action.session.durationMinutes} min\${action.session.location ? \` | \${action.session.location}\` : ""}`;

if (!source.includes(newExampleSuffix)) {
  if (!source.includes(oldExampleSuffix)) {
    throw new Error("Could not locate the calendar change-example formatter.");
  }
  source = source.replace(oldExampleSuffix, newExampleSuffix);
}

await writeFile(path, source, "utf8");
console.log("Applied 45-minute soccer and 90-minute pickleball calendar durations.");
