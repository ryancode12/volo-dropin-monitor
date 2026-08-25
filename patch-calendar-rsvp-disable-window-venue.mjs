import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-sync.mjs";
let source = await readFile(path, "utf8");

const startMarker = `    // Final safe fallback: use the Daily Sports program window only when one unique
    // venue contains the exact registered game's local start time.
    for (const session of targets.filter((item) => !usableLocationValue(item.location))) {`;
const endMarker = `    // Never pass stale generic text forward to Google Calendar.`;

if (source.includes(startMarker)) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error("Could not locate the end of the time-window venue fallback block.");
  source =
    source.slice(0, start) +
    `    // Do not infer a venue from a broad program time window. Exact-game sources only.\n\n` +
    source.slice(end);
}

await writeFile(path, source, "utf8");
console.log("Disabled broad time-window venue inference; exact-game venue sources only.");
