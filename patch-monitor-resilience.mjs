import { readFile, writeFile } from "node:fs/promises";

const path = "monitor.mjs";
let source = await readFile(path, "utf8");

source = source.replaceAll("timeout: 45_000", "timeout: 120_000");

if (!source.includes("timeout: 120_000,\n    protocolTimeout: 300_000,")) {
  if (source.includes("protocolTimeout: 300_000,\n    headless: true,")) {
    source = source.replace(
      "protocolTimeout: 300_000,\n    headless: true,",
      "timeout: 120_000,\n    protocolTimeout: 300_000,\n    headless: true,"
    );
  } else {
    const launchMarker = "    executablePath: CHROME_PATH,\n    headless: true,";
    if (!source.includes(launchMarker)) {
      throw new Error("Could not locate monitor Puppeteer launch options.");
    }
    source = source.replace(
      launchMarker,
      "    executablePath: CHROME_PATH,\n    timeout: 120_000,\n    protocolTimeout: 300_000,\n    headless: true,"
    );
  }
}

const mainMarker = "async function main() {";
if (!source.includes("async function scrapeMatchesWithRetry(")) {
  if (!source.includes(mainMarker)) throw new Error("Could not locate monitor main().");
  const helper = `async function scrapeMatchesWithRetry(attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await scrapeMatches();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(\`Volo monitor scrape attempt ${"${attempt}