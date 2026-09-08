import { readFile, writeFile } from "node:fs/promises";

const path = "monitor.mjs";
let source = await readFile(path, "utf8");

// Allow slow Volo navigations enough time to finish on busy GitHub runners.
source = source.replaceAll("timeout: 45_000", "timeout: 120_000");

// Ensure Puppeteer itself also tolerates a slow Chrome startup/protocol call.
const launchNeedle = "    executablePath: CHROME_PATH,";
if (!source.includes(launchNeedle)) {
  throw new Error("Could not locate monitor Puppeteer launch options.");
}

if (!source.includes("timeout: 120_000,")) {
  source = source.replace(
    launchNeedle,
    launchNeedle + "\n    timeout: 120_000,"
  );
}

if (!source.includes("protocolTimeout: 300_000,")) {
  source = source.replace(
    launchNeedle,
    launchNeedle + "\n    protocolTimeout: 300_000,"
  );
}

const mainMarker = "async function main() {";
if (!source.includes("async function scrapeMatchesWithRetry(")) {
  if (!source.includes(mainMarker)) {
    throw new Error("Could not locate monitor main().");
  }

  const helper = [
    "async function scrapeMatchesWithRetry(attempts = 3) {",
    "  let lastError;",
    "  for (let attempt = 1; attempt <= attempts; attempt += 1) {",
    "    try {",
    "      return await scrapeMatches();",
    "    } catch (error) {",
    "      lastError = error;",
    "      const message = error instanceof Error ? error.message : String(error);",
    "      console.error(\"Volo monitor scrape attempt \" + attempt + \"/\" + attempts + \" failed: \" + message);",
    "      if (attempt < attempts) {",
    "        await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));",
    "      }",
    "    }",
    "  }",
    "  throw lastError ?? new Error(\"Volo monitor scrape failed after retries.\");",
    "}",
    "",
  ].join("\n");

  source = source.replace(mainMarker, helper + mainMarker);
}

const scrapeCall = "    const matches = await scrapeMatches();";
const retryCall = "    const matches = await scrapeMatchesWithRetry();";
if (source.includes(scrapeCall)) {
  source = source.replace(scrapeCall, retryCall);
} else if (!source.includes(retryCall)) {
  throw new Error("Could not locate monitor scrape call in main().");
}

await writeFile(path, source, "utf8");
console.log("Applied Volo monitor browser timeout and retry resilience.");
