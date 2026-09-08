import { readFile } from "node:fs/promises";

const source = await readFile("monitor.mjs", "utf8");

const requiredSnippets = [
  "async function loginToVolo(page) {",
  "await loginToVolo(page);",
  "async function hasMensAvailability(",
  "Authoritative Volo game inventory:",
  "Verified male-eligible Volo inventory:",
];

const missing = requiredSnippets.filter((snippet) => !source.includes(snippet));
if (missing.length > 0) {
  throw new Error(
    "Composed monitor is missing required runtime pieces: " + missing.join(", ")
  );
}

const loginDefinition = source.indexOf("async function loginToVolo(page) {");
const scrapeDefinition = source.indexOf("async function scrapeMatches() {");
const loginCall = source.indexOf("await loginToVolo(page);", scrapeDefinition);

if (loginDefinition < 0 || scrapeDefinition < 0 || loginDefinition > scrapeDefinition) {
  throw new Error("loginToVolo() must be defined before scrapeMatches().");
}

if (loginCall < scrapeDefinition) {
  throw new Error("scrapeMatches() does not call loginToVolo().");
}

console.log("Composed monitor validation passed: login and authoritative inventory logic are present.");
