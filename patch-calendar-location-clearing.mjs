import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-sync.mjs";
let source = await readFile(path, "utf8");

const oldLocation = `    location: session.location || undefined,`;
const newLocation = `    location: session.location || "",`;

if (!source.includes(newLocation)) {
  if (!source.includes(oldLocation)) {
    throw new Error("Could not locate Calendar event location field.");
  }
  source = source.replace(oldLocation, newLocation);
}

await writeFile(path, source, "utf8");
console.log("Configured Calendar sync to clear stale locations when Volo has no valid venue.");
