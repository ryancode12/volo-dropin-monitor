import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-operation-diagnostic.mjs";
let source = await readFile(path, "utf8");

source = source.replace(
  `const pattern = /upcoming|schedule|calendar|my games|games|events|activities|daily sports|pickup|drop-?in|reservation|registration/i;`,
  `const pattern = /soccer|team|league|program|season|upcoming|schedule|calendar|my games|games|events|activities|daily sports|pickup|drop-?in|reservation|registration/i;`
);
source = source.replace(`return results.slice(0, 40);`, `return results.slice(0, 100);`);

const oldLabels = `    const safeLabels = [...new Set(initialControls.map((item) => item.text).filter(Boolean))].slice(0, 10);`;
const newLabels = `    const uniqueLabels = [...new Set(initialControls.map((item) => item.text).filter(Boolean))];
    const safeLabels = [
      ...uniqueLabels.filter((label) => /soccer|team|league/i.test(label)),
      ...uniqueLabels.filter((label) => !/soccer|team|league/i.test(label)),
    ].slice(0, 12);`;
if (!source.includes(newLabels)) {
  if (!source.includes(oldLabels)) throw new Error("Could not locate navigation labels.");
  source = source.replace(oldLabels, newLabels);
}

const oldPaths = `    const paths = [
      ...new Set(
        controls
          .map((item) => item.path)
          .filter((path) => path && path.startsWith("/app/") && path !== "/app/dashboard")
      ),
    ].slice(0, 10);`;
const newPaths = `    const routeControls = [...new Map(
      controls
        .filter((item) => item.path && item.path.startsWith("/app/") && item.path !== "/app/dashboard")
        .map((item) => [item.path, item])
    ).values()];
    const paths = [
      ...routeControls.filter((item) => /soccer|team|league/i.test(item.text || "")),
      ...routeControls.filter((item) => !/soccer|team|league/i.test(item.text || "")),
    ].slice(0, 12).map((item) => item.path);`;
if (!source.includes(newPaths)) {
  if (!source.includes(oldPaths)) throw new Error("Could not locate route list.");
  source = source.replace(oldPaths, newPaths);
}

await writeFile(path, source, "utf8");
console.log("Applied soccer route discovery patch.");
