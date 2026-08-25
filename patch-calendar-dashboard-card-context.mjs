import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-sync.mjs";
let source = await readFile(path, "utf8");

const oldBlock = `    for (const link of document.querySelectorAll('a[href*="/app/member/"]')) {
      const match = link.href.match(/\\/app\\/member\\/([^/?#]+)/i);
      const routeId = match?.[1] || "";
      const text = clean(link.innerText || link.textContent);
      if (!routeId || !text) continue;
      const identity = \`${"${routeId}|${text}"}\`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      cards.push({ routeId, text });
    }`;

const newBlock = `    const hasSessionDateTime = (text) =>
      /\\b(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\\s+\\d{1,2}\\/\\d{1,2}\\b/i.test(text) &&
      /\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\b/i.test(text);

    for (const link of document.querySelectorAll('a[href*="/app/member/"]')) {
      const match = link.href.match(/\\/app\\/member\\/([^/?#]+)/i);
      const routeId = match?.[1] || "";
      if (!routeId) continue;

      let text = clean(link.innerText || link.textContent);

      // Some registered daily-sports cards keep the date, time, sport, and venue
      // in the surrounding card rather than inside the member link itself.
      if (!hasSessionDateTime(text)) {
        let ancestor = link.parentElement;
        for (let depth = 0; ancestor && depth < 7; depth += 1, ancestor = ancestor.parentElement) {
          const candidate = clean(ancestor.innerText || ancestor.textContent);
          if (
            hasSessionDateTime(candidate) &&
            /\\b(?:soccer|pickleball|volleyball|basketball|kickball|softball|football|dodgeball|cornhole)\\b/i.test(candidate) &&
            candidate.length <= 1_200
          ) {
            text = candidate;
            break;
          }
        }
      }

      if (!text || !hasSessionDateTime(text)) continue;
      const identity = \`${"${routeId}|${text}"}\`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      cards.push({ routeId, text });
    }`;

if (!source.includes("Some registered daily-sports cards keep the date, time, sport, and venue")) {
  if (!source.includes(oldBlock)) {
    throw new Error("Could not locate dashboard member-card collection loop.");
  }
  source = source.replace(oldBlock, newBlock);
}

await writeFile(path, source, "utf8");
console.log("Expanded registered daily-sports card extraction to surrounding dashboard card context.");
