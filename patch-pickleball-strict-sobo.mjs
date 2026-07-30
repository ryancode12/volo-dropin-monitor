import { readFile, writeFile } from "node:fs/promises";

const path = "pickleball-monitor.mjs";
let source = await readFile(path, "utf8");

const oldSources =
  "const SOURCE_URLS = [...new Set([DISCOVER_URL, PICKLEBALL_LANDING_URL])];";
const strictSources = "const SOURCE_URLS = [DISCOVER_URL];";
if (!source.includes(strictSources)) {
  if (!source.includes(oldSources)) {
    throw new Error("Could not locate pickleball source list.");
  }
  source = source.replace(oldSources, strictSources);
}

const genericRatioBlock = `  const ratio = /\\b(\\d+)\\s*\\/\\s*(\\d+)\\b/.exec(normalized);
  if (ratio) {
    const registered = Number(ratio[1]);
    const capacity = Number(ratio[2]);
    if (capacity >= registered && capacity >= 4) {
      return {
        registered,
        capacity,
        remaining: capacity - registered,
        availabilitySource: \`${"${registered}/${capacity}"}\`,
      };
    }
  }

`;
if (source.includes(genericRatioBlock)) {
  source = source.replace(genericRatioBlock, "");
}

const parseCardMarker = `function parseCard(text) {
  const normalized = normalizeText(text);
  const availability = parseAvailability(normalized);`;
const strictParseCard = `function parseCard(text) {
  const normalized = normalizeText(text);
  const venueMatches =
    normalized.match(/club\\s+volo\\s+sobo\\s*-?\\s*indoor/gi) || [];
  const pickupMatches = normalized.match(/\\bpickleball\\s+pickup\\b/gi) || [];

  // Reject broad page containers and cards from any other venue. A valid event
  // container must describe exactly one SoBo pickup.
  if (venueMatches.length !== 1 || pickupMatches.length !== 1) return null;
  if (/volo\\s+sports\\s+arena|\\brino\\b/i.test(normalized)) return null;

  const availability = parseAvailability(normalized);`;
if (!source.includes("A valid event\n  // container must describe exactly one SoBo pickup.")) {
  if (!source.includes(parseCardMarker)) {
    throw new Error("Could not locate pickleball card parser.");
  }
  source = source.replace(parseCardMarker, strictParseCard);
}

const oldRelevant = `      const relevant = (text) =>
        /\\bpickleball\\b/i.test(text) &&
        /\\bpickup\\b/i.test(text) &&
        /club\\s+volo\\s+sobo\\s*-?\\s*indoor/i.test(text) &&
        hasAvailability(text);`;
const strictRelevant = `      const relevant = (text) => {
        const venueMatches =
          text.match(/club\\s+volo\\s+sobo\\s*-?\\s*indoor/gi) || [];
        const pickupMatches = text.match(/\\bpickleball\\s+pickup\\b/gi) || [];
        return (
          venueMatches.length === 1 &&
          pickupMatches.length === 1 &&
          !/volo\\s+sports\\s+arena|\\brino\\b/i.test(text) &&
          hasAvailability(text)
        );
      };`;
if (!source.includes("venueMatches.length === 1 &&")) {
  if (!source.includes(oldRelevant)) {
    throw new Error("Could not locate pickleball event-container filter.");
  }
  source = source.replace(oldRelevant, strictRelevant);
}

await writeFile(path, source, "utf8");
console.log(
  "Restricted pickleball monitoring to unambiguous Club Volo SoBo - Indoor cards and explicit availability labels."
);
