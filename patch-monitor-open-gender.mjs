import { readFile, writeFile } from "node:fs/promises";

const path = "monitor.mjs";
let source = await readFile(path, "utf8");

const marker = "    const anyGenderCount = readCount([\n";
if (!source.includes(marker)) {
  throw new Error("Could not locate any-gender inventory parser in monitor.mjs");
}

if (!source.includes("open\\s+gender")) {
  const replacement =
    marker +
    "      /\\bopen\\s+gender\\s*[:\\-]?\\s*(\\d+)\\b/i,\n" +
    "      /\\b(\\d+)\\s+open\\s+gender\\b/i,\n";
  source = source.replace(marker, replacement);
}

await writeFile(path, source, "utf8");
console.log("Added Open Gender inventory support to the Volo soccer monitor.");
