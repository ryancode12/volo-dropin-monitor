import { readFile, writeFile } from "node:fs/promises";

const path = "monitor.mjs";
let source = await readFile(path, "utf8");

const parserImport =
  'import { parseVoloGameInventory } from "./volo-inventory-parser.mjs";\n';
if (!source.includes(parserImport.trim())) {
  source = parserImport + source;
}

const startMarker = "async function hasMensAvailability(";
const start = source.indexOf(startMarker);

// Replace only hasMensAvailability(). The authenticated-session patch may have
// already inserted login helpers between this function and scrapeMatches(), so
// using scrapeMatches() as the only end marker can accidentally delete them.
const endMarkers = [
  "\nasync function firstExistingSelector(",
  "\nasync function loginToVolo(",
  "\nasync function scrapeMatches() {",
];
const endCandidates = endMarkers
  .map((marker) => source.indexOf(marker, start))
  .filter((index) => index >= 0);
const end = endCandidates.length > 0 ? Math.min(...endCandidates) : -1;

if (start < 0 || end < 0 || end <= start) {
  throw new Error("Could not safely locate hasMensAvailability() boundaries in monitor.mjs");
}

const replacement = `async function hasMensAvailability(browser, rawUrl, listingText = "") {
  const url = cleanUrl(rawUrl);
  const parsed = new URL(url);

  // Eligibility must be checked on an exact authenticated game page. Discover
  // totals can include spots reserved for a gender that the current user cannot claim.
  if (/\\/discover(?:\\/|$)/i.test(parsed.pathname)) {
    console.log("Skipping unverified generic discovery URL: " + url);
    return false;
  }

  const detailsPage = await browser.newPage();
  try {
    await detailsPage.emulateTimezone("America/Denver");
    await detailsPage.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
    await detailsPage.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
    );

    await detailsPage.setRequestInterception(true);
    detailsPage.on("request", (request) => {
      const blockedTypes = new Set(["image", "media", "font"]);
      if (blockedTypes.has(request.resourceType())) request.abort();
      else request.continue();
    });

    await detailsPage.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    await detailsPage.waitForNetworkIdle({ idleTime: 1_000, timeout: 25_000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const detail = await detailsPage.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: String(document.body?.innerText ?? "").replace(/\\s+/g, " ").trim(),
      controls: [...document.querySelectorAll("button, a, [role='button']")]
        .map((element) => String(element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim())
        .filter((text) => /log|sign|register|drop|spot|gender|women|men|choose|waitlist|sold/i.test(text))
        .slice(0, 30),
    }));

    if (/\\/login(?:\\/|$|\\?)/i.test(detail.url)) {
      throw new Error("Authenticated game inventory check redirected to login.");
    }

    const pageText = detail.text;
    const inventory = parseVoloGameInventory(pageText);
    const {
      total: totalCount,
      men: menCount,
      anyGender: anyGenderCount,
      openGender: openGenderCount,
      womenOnly: womenOnlyCount,
      eligible: eligibleCount,
      source: inventorySource,
    } = inventory;

    console.log(
      "Authoritative Volo game inventory: " +
        JSON.stringify({
          url,
          total: totalCount,
          men: menCount,
          anyGender: anyGenderCount,
          openGender: openGenderCount,
          womenOnly: womenOnlyCount,
          eligible: eligibleCount,
          source: inventorySource,
          listing: normalizeText(listingText).slice(0, 180),
        })
    );

    if (inventorySource === "unknown") {
      console.log(
        "VOLO_NULL_INVENTORY_DIAG " +
          JSON.stringify({
            requestedUrl: url,
            finalUrl: detail.url,
            title: detail.title,
            textLength: detail.text.length,
            textPreview: detail.text.slice(0, 1800),
            controls: detail.controls,
          })
      );
    }

    if (eligibleCount > 0) {
      console.log("Verified male-eligible Volo inventory: " + url);
      return true;
    }

    if ((womenOnlyCount ?? 0) > 0) {
      console.log("Skipping Volo inventory restricted to women/non-binary: " + url);
      return false;
    }

    if (totalCount === 0 || /\\bsold\\s+out\\b/i.test(pageText)) {
      console.log("Skipping Volo game with no current inventory: " + url);
      return false;
    }

    // Do not infer eligibility from a generic total or a Coed card. Volo can
    // show a positive total while every remaining slot is gender-restricted.
    console.log("Could not verify a male-eligible inventory bucket on Volo game page: " + url);
    return false;
  } finally {
    await detailsPage.close();
  }
}
`;

source = source.slice(0, start) + replacement + source.slice(end);
await writeFile(path, source, "utf8");
console.log("Applied authoritative authenticated Volo game-inventory eligibility parsing.");
