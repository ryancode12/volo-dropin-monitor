await import("./patch-calendar-soccer-route-discovery.mjs");
await import("./patch-calendar-team-schedule-game-values.mjs");
import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-operation-diagnostic.mjs";
let source = await readFile(path, "utf8");

const versionLine = `      "Soccer diagnostic version: current-operations-v4.",`;
if (!source.includes(versionLine)) {
  const loginLine = `      "Volo login: OK.",`;
  if (!source.includes(loginLine)) {
    throw new Error("Could not locate the Volo login notification line.");
  }
  source = source.replace(loginLine, `${loginLine}\n${versionLine}`);
}

source = source.replace(
  "Schedule-related controls:",
  "Soccer/team schedule-related controls:"
);
source = source.replace(
  "Schedule-related controls: none detected.",
  "Soccer/team schedule-related controls: none detected."
);

await writeFile(path, source, "utf8");
console.log("Applied current-operations soccer diagnostic patch v4.");
