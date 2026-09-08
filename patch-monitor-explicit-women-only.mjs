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
  "    // Volo can flatten a two-column availability widget into text such as",
  "    // 'Total Spot(s) Available 1 Women only Any gender 0 1'. Never use a",
  "    // number BEFORE 'Women only' as that category's count, because that",
  "    // number may be the overall total rather than women-only inventory.",
  "    let womenOnlyCount = readCount([",
  "      /\\bwomen(?:'s)?\\s+only\\s*[:\\-]?\\s*(\\d+)\\b/i,",
  "    ]);",
  "",
  "    let eligibleCount = readCount([",
  "      /\\bany\\s+gender\\s*[:\\-]?\\s*(\\d+)\\b/i,",
  "      /\\bopen\\s+gender\\s*[:\\-]?\\s*(\\d+)\\b/i,",
  "      /\\bno\\s+preference\\s*[:\\-]?\\s*(\\d+)\\b/i,",
  "    ]);",
  "",
  "    // Current Volo/mobile-style markup can place both labels first and both",
  "    // numeric values afterward: 'Women only Any gender 0 1'. In that layout",
  "    // the first trailing value belongs to Women only and the second belongs",
  "    // to Any/Open Gender.",
  "    const pairedInventory = pageText.match(",
  "      /\\bwomen(?:'s)?\\s+only\\b[\\s\\S]{0,80}?\\b(?:any|open)\\s+gender\\b[\\s:,-]{0,20}(\\d+)\\s+(\\d+)\\b/i",
  "    );",
  "    if (pairedInventory) {",
  "      womenOnlyCount = Number(pairedInventory[1]);",
  "      eligibleCount = Number(pairedInventory[2]);",
  "    }",
  "",
  "    console.log(",
  "      'Parsed Volo gender inventory: womenOnly=' +",
  "        String(womenOnlyCount) +",
  "        ' eligible=' +",
  "        String(eligibleCount) +",
  "        ' | ' +",
  "        url",
  "    );",
  "",
  "    if ((eligibleCount ?? 0) > 0) {",
  "      console.log(\"Verified eligible any/open-gender availability: \" + url);",
  "      return true;",
  "    }",
  "",
  "    const listingLabel = normalizeText(listingText);",
  "    const explicitWomensProgram =",
  "      /\\bsoccer\\s+drop[ -]?in\\s*-\\s*(?:women|women's|female)\\b/i.test(pageText) ||",
  "      /\\b(?:women|women's|female)[ -]?only\\s+(?:soccer|drop[ -]?in|program|game)\\b/i.test(pageText) ||",
  "      /\\b(?:women|women's|female)[ -]?only\\b/i.test(listingLabel);",
  "",
  "    // A zero women-only count is affirmative evidence that the currently",
  "    // available spot is not restricted to women. Coed/Open/Men listings",
  "    // remain eligible even when Volo also renders women's roster data.",
  "    if (womenOnlyCount === 0) {",
  "      if (/\\b(?:men(?:'s)?|coed|open(?:\\s+gender)?)\\b/i.test(listingLabel) || !explicitWomensProgram) {",
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
} else if (!source.includes("Parsed Volo gender inventory:")) {
  throw new Error("Could not locate unsafe women-count rejection block in monitor.mjs");
}

await writeFile(path, source, "utf8");
console.log("Applied count-aware Volo paired gender-inventory parsing.");
