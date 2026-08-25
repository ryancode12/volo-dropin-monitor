import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-sync.mjs";
let source = await readFile(path, "utf8");

const helperMarker = "function findDropInGameObject(value, depth = 0) {";
const helper = `function collectRsvpRegistrantArrays(value, output = [], depth = 0) {
  if (value == null || depth > 12) return output;

  if (Array.isArray(value)) {
    for (const item of value) collectRsvpRegistrantArrays(item, output, depth + 1);
    return output;
  }

  if (typeof value !== "object") return output;

  for (const [key, child] of Object.entries(value)) {
    if (
      /^registrants$/i.test(key) &&
      Array.isArray(child) &&
      child.some(
        (item) =>
          item &&
          typeof item === "object" &&
          (item.gameByDropInGame || item?.dropIn?.gameByGame)
      )
    ) {
      output.push(child);
    }
    collectRsvpRegistrantArrays(child, output, depth + 1);
  }

  return output;
}

`;

if (!source.includes("function collectRsvpRegistrantArrays(")) {
  if (!source.includes(helperMarker)) {
    throw new Error("Run the RSVP GraphQL fallback patch before the response-shape patch.");
  }
  source = source.replace(helperMarker, helper + helperMarker);
}

const oldCapture = `            const registrants = responseItem?.data?.data?.registrants;
            if (Array.isArray(registrants)) rsvpRegistrants.push(...registrants);`;
const newCapture = `            let registrantArrays = collectRsvpRegistrantArrays(responseItem);
            if (registrantArrays.length === 0) {
              registrantArrays = collectRsvpRegistrantArrays(responseJson);
            }
            for (const registrants of registrantArrays) {
              rsvpRegistrants.push(...registrants);
            }`;

if (!source.includes("registrantArrays = collectRsvpRegistrantArrays(responseItem)")) {
  if (!source.includes(oldCapture)) {
    throw new Error("Could not locate the rigid myDropInRsvps registrant extractor.");
  }
  source = source.replace(oldCapture, newCapture);
}

await writeFile(path, source, "utf8");
console.log("Made myDropInRsvps registrant extraction resilient to nested/batched GraphQL response shapes.");
