import { readFile, writeFile } from "node:fs/promises";

const targets = [
  {
    path: "volo-calendar-sync.mjs",
    signature: 'async function notify(title, message, priority = "3", tags = "calendar") {',
  },
  {
    path: "volo-calendar-soccer-sync.mjs",
    signature:
      'async function notify(title, message, priority = "3", tags = "calendar,soccer") {',
  },
];

const policyLine =
  '  // Routine calendar changes stay silent; only failures send an ntfy alert.\n' +
  '  if (!/\\bfailed\\b/i.test(String(title))) return;';

for (const target of targets) {
  let source = await readFile(target.path, "utf8");

  if (!source.includes("Routine calendar changes stay silent")) {
    if (!source.includes(target.signature)) {
      throw new Error(`Could not locate notify function in ${target.path}.`);
    }

    source = source.replace(target.signature, `${target.signature}\n${policyLine}`);
    await writeFile(target.path, source, "utf8");
  }
}

console.log("Configured pickup and soccer calendar syncs for failure-only ntfy alerts.");
