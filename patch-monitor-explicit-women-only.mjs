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
  "    // Volo can display category labels such as 'Women only 0' next to",
  "    // 'Any gender 1'. The label text by itself must never reject a game.",
  "    const womenOnlyCount = readCount([",
  "      /\\bwomen(?:'s)?\\s+only\\s*[:\\-]?\\s*(\\d+)\\b/i,",
  "      /\\b(\\d+)\\s+women(?:'s)?\\s+only\\b/i,",
  "    ]);",
  "",
  "    // Re-check all current male-eligible labels. This is intentionally",
  "    // redundant with anyGenderCount so minor Volo UI wording changes do",
  "    // not turn 'Women only 0 / Any gender 1' into a false negative.",
  "    const eligibleCount = readCount([",
  "      /\\bany\\s+gender\\s*[:\\-]?\\s*(\\d+)\\b/i,",
  "      /\\b(\\d+)\\s+any\\s+gender\\b/i,",
  "      /\\bopen\\s+gender\\s*[:\\-]?\\s*(\\d+)\\b/i,",
  "      /\\b(\\d+)\\s+open\\s+gender\\b/i,",
  "      /\\bno\\s+preference\\s*[:\\-]?\\s*(\\d+)\\b/i,",
  "    ]);",
  "",
  "    if ((eligibleCount ?? 0) > 0) {",
  "      console.log(\"Verified eligible any/open-gender availability: \" + url);",
  "      return true;",
  "    }",
  "",
  "    const listing = normalizeText(listingText);",
  "    const explicitWomensProgram =",
  "      /\\bsoccer\\s+drop[ -]?in\\s*-\\s*(?:women|women's|female)\\b/i.test(pageText) ||",
  "      /\\b(?:women|women's|female)[ -]?only\\s+(?:soccer|drop[ -]?in|program|game)\\b/i.test(pageText) ||",
  "      /\\b(?:women|women's|female)[ -]?only\\b/i.test(listing);",
  "",
  "    // A zero women-only count is affirmative evidence that the currently",
  "    // available spot is not restricted to women. Coed/Open/Men listings",
  "    // remain eligible even when Volo also renders women's roster data.",
  "    if (womenOnlyCount === 0) {",
  "      if (/\\b(?:men(?:'s)?|coed|open(?:\\s+gender)?)\\b/i.test(listing) || !explicitWomensProgram) {",
  "        console.log(\"Women-only inventory is zero; keeping eligible listing: \" + url);",
  "        return true;",
  "      }",
  "    }",
  "",
  "    // Reject only explicit positive women-only inventory, or a clearly",
  "    // women-only program when there is no verified eligible inventory.",
  "    if ((womenOnlyCount ?? 0) > 0 || explicitWomensProgram) {",
  "      console.log(\"Skipping verified women-only availability: \" + url);",
  "      return false;",
  "    }",
].join("\n");

if (source.includes(oldBlock)) {
  source = source.replace(oldBlock, newBlock);
} else if (!source.includes("Women-only inventory is zero; keeping eligible listing:")) {
  throw new Error("Could not locate unsafe women-count rejection block in monitor.mjs");
}

await writeFile(path, source, "utf8");
console.log("Replaced broad women-count rejection with count-aware explicit women-only logic.");
