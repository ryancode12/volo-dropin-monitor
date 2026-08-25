import { readFile, writeFile } from "node:fs/promises";

const target = process.argv[2];
const supported = new Set(["volo-calendar-sync.mjs", "volo-calendar-soccer-sync.mjs"]);
if (!supported.has(target)) {
  throw new Error(
    "Usage: node patch-calendar-browser-resilience.mjs <volo-calendar-sync.mjs|volo-calendar-soccer-sync.mjs>"
  );
}

let source = await readFile(target, "utf8");

// Give Volo navigation more room on slow GitHub-hosted runners.
source = source.replaceAll("timeout: 45_000", "timeout: 120_000");

// Make Chrome startup and DevTools protocol calls resilient as well. The workflow
// may already inject these values; these replacements are intentionally idempotent.
if (!source.includes("timeout: 120_000,\n    protocolTimeout: 300_000,")) {
  if (source.includes("protocolTimeout: 300_000,\n    headless: true,")) {
    source = source.replace(
      "protocolTimeout: 300_000,\n    headless: true,",
      "timeout: 120_000,\n    protocolTimeout: 300_000,\n    headless: true,"
    );
  } else {
    const launchMarker = "    executablePath: CHROME_PATH,\n    headless: true,";
    if (!source.includes(launchMarker)) {
      throw new Error(`Could not locate Puppeteer launch options in ${target}.`);
    }
    source = source.replace(
      launchMarker,
      "    executablePath: CHROME_PATH,\n    timeout: 120_000,\n    protocolTimeout: 300_000,\n    headless: true,"
    );
  }
}

const mainMarker = "async function main() {";
if (!source.includes("async function readVoloWithRetry(")) {
  if (!source.includes(mainMarker)) {
    throw new Error(`Could not locate main() in ${target}.`);
  }

  const helper = `async function readVoloWithRetry(label, operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(\`${"${label}