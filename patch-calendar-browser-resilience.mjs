import { readFile, writeFile } from "node:fs/promises";

const target = process.argv[2];
const supported = new Set(["volo-calendar-sync.mjs", "volo-calendar-soccer-sync.mjs"]);
if (!supported.has(target)) {
  throw new Error(
    "Usage: node patch-calendar-browser-resilience.mjs <volo-calendar-sync.mjs|volo-calendar-soccer-sync.mjs>"
  );
}

let source = await readFile(target, "utf8");

// Give Volo page navigation more room on slow GitHub-hosted runners.
source = source.replaceAll("timeout: 45_000", "timeout: 120_000");

// Give Chrome startup and DevTools protocol calls more room as well.
if (!source.includes("protocolTimeout: 300_000,")) {
  const launchMarker = "    executablePath: CHROME_PATH,\n    headless: true,";
  if (!source.includes(launchMarker)) {
    throw new Error("Could not locate Puppeteer launch options in " + target + ".");
  }
  source = source.replace(
    launchMarker,
    "    executablePath: CHROME_PATH,\n    timeout: 120_000,\n    protocolTimeout: 300_000,\n    headless: true,"
  );
}

const mainMarker = "async function main() {";
if (!source.includes("async function readVoloWithRetry(")) {
  if (!source.includes(mainMarker)) {
    throw new Error("Could not locate main() in " + target + ".");
  }

  const helper = [
    "async function readVoloWithRetry(label, operation, attempts = 3) {",
    "  let lastError;",
    "  for (let attempt = 1; attempt <= attempts; attempt += 1) {",
    "    try {",
    "      return await operation();",
    "    } catch (error) {",
    "      lastError = error;",
    "      const message = error instanceof Error ? error.message : String(error);",
    "      console.error(label + ' attempt ' + attempt + '/' + attempts + ' failed: ' + message);",
    "      if (attempt < attempts) {",
    "        await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));",
    "      }",
    "    }",
    "  }",
    "  throw lastError;",
    "}",
    "",
  ].join("\n");

  source = source.replace(mainMarker, helper + mainMarker);
}

if (target === "volo-calendar-sync.mjs") {
  const oldRead = "    const dashboard = await loadUpcomingSessions();";
  const retryRead =
    "    const dashboard = await readVoloWithRetry('Pickup Volo read', () => loadUpcomingSessions());";
  if (!source.includes(retryRead)) {
    if (!source.includes(oldRead)) {
      throw new Error("Could not locate pickup Volo read in " + target + ".");
    }
    source = source.replace(oldRead, retryRead);
  }
} else {
  const oldRead = "    const dashboard = await loadUpcomingSoccerGames();";
  const retryRead =
    "    const dashboard = await readVoloWithRetry('Soccer Volo read', () => loadUpcomingSoccerGames());";
  if (!source.includes(retryRead)) {
    if (!source.includes(oldRead)) {
      throw new Error("Could not locate soccer Volo read in " + target + ".");
    }
    source = source.replace(oldRead, retryRead);
  }
}

await writeFile(target, source, "utf8");
console.log("Applied browser and authenticated-read resilience to " + target + ".");
