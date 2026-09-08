import { readFile, writeFile } from "node:fs/promises";

const path = "monitor.mjs";
let source = await readFile(path, "utf8");

const oldBlock = [
  "    // Reject only when the remaining inventory is explicitly women-only.",
  "    if (womenCount !== null && womenCount > 0) {",
  "      console.log(\"Skipping women-only availability: \" + url);",
  "      return false;",
  "    }",
].join("\n");

const newBlock = [
  "    // Do not treat any generic women-related number on a Volo page as proof",
  "    // that the open drop-in is women-only. Current coed pages can contain",
  "    // women roster/requirement counts unrelated to the available spot.",
  "    const explicitWomenOnly =",
  "      /\\b(?:women(?:'s)?|female)[ -]?only\\b/i.test(pageText) ||",
  "      /\\b(?:women(?:'s)?|female)\\s+spots?\\s*(?:only|available|left|remaining)\\b/i.test(pageText) ||",
  "      /\\b\\d+\\s+(?:women(?:'s)?|female)\\s+spots?\\b/i.test(pageText);",
  "",
  "    if (explicitWomenOnly) {",
  "      console.log(\"Skipping explicitly women-only availability: \" + url);",
  "      return false;",
  "    }",
].join("\n");

if (source.includes(oldBlock)) {
  source = source.replace(oldBlock, newBlock);
} else if (!source.includes("Skipping explicitly women-only availability:")) {
  throw new Error("Could not locate unsafe women-count rejection block in monitor.mjs");
}

await writeFile(path, source, "utf8");
console.log("Replaced broad women-count rejection with explicit women-only detection.");
