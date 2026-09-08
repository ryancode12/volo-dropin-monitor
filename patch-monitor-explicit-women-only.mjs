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
  "    // 'Any gender 1'. The words 'Women only' alone do NOT mean the open",
  "    // inventory is restricted to women; the numeric inventory must agree.",
  "    const womenOnlyCount = readCount([",
  "      /\\bwomen(?:'s)?\\s+only\\s*[:\\-]?\\s*(\\d+)\\b/i,",
  "      /\\b(\\d+)\\s+women(?:'s)?\\s+only\\b/i,",
  "    ]);",
  "",
  "    // Re-check eligible inventory with the current Volo labels. This is",
  "    // intentionally redundant with anyGenderCount so UI wording changes",
  "    // cannot make 'Women only 0 / Any gender 1' a false negative.",
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
  "    // A zero women-only count is affirmative evidence that the visible",
  "    // open inventory is not women-only. Do not reject merely because the",
  "    // category label itself appears on the page.",
  "    if (womenOnlyCount === 0 || womenCount === 0) {",
  "      const listing = normalizeText(listingText);",
  "      if (/\\b(?:men(?:'s)?|coed|open(?:\\s+gender)?)\\b/i.test(listing)) {",
  "        console.log(\"Women-only inventory is zero; accepting eligible listing: \" + url);",
  "        return true;",
  "      }",
  "    }",
  "",
  "    // Reject only when positive women-only inventory is the only explicit",
  "    // gender inventory we can verify.",
  "    if ((womenOnlyCount ?? womenCount ?? 0) > 0) {",
  "      console.log(\"Skipping verified women-only availability: \" + url);",
  "      return false;",
  "    }",
].join("\n");

if (source.includes(oldBlock)) {
  source = source.replace(oldBlock, newBlock);
} else if (!source.includes("Verified eligible any/open-gender availability:")) {
  throw new Error("Could not locate unsafe women-count rejection block in monitor.mjs");
}

await writeFile(path, source, "utf8");
console.log("Replaced broad women-count rejection with count-aware gender inventory logic.");
