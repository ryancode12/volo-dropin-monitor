import { readFile, writeFile } from "node:fs/promises";

const path = "monitor.mjs";
let source = await readFile(path, "utf8");

const timezoneLine = '    await page.emulateTimezone("America/Denver");';
const newPageLine = "    const page = await browser.newPage();";
if (!source.includes(timezoneLine)) {
  if (!source.includes(newPageLine)) {
    throw new Error("Could not locate Puppeteer page creation in monitor.mjs");
  }
  source = source.replace(newPageLine, `${newPageLine}\n${timezoneLine}`);
}

const startMarker = "function parseEventDetails(text) {";
const endMarker = "\n\nfunction stableId(match) {";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);

if (start === -1 || end === -1) {
  throw new Error("Could not locate parseEventDetails in monitor.mjs");
}

const replacement = [
  "function parseEventDetails(text) {",
  "  const normalized = normalizeText(text);",
  "  const weekdayPattern =",
  "    \"(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\";",
  "",
  "  const header = new RegExp(",
  "    \"Drop[\\\\s-]*In\\\\s+\" + weekdayPattern + \"\\\\s*-\\\\s*Soccer\\\\s*-\\\\s*(.*?)\\\\s*-\\\\s*Drop[\\\\s-]*In\\\\s+\" ,",
  "    \"i\"",
  "  ).exec(normalized);",
  "",
  "  const day =",
  "    header?.[1] ??",
  "    new RegExp(weekdayPattern + \"\\\\s*-\\\\s*Soccer\", \"i\").exec(normalized)?.[1] ??",
  "    new RegExp(\"\\\\b\" + weekdayPattern + \"\\\\b\", \"i\").exec(normalized)?.[1] ??",
  "    \"Unknown day\";",
  "",
  "  const searchFrom = header",
  "    ? normalized.slice(header.index + header[0].length)",
  "    : normalized;",
  "",
  "  const spotIndex = searchFrom.search(",
  "    /\\b(?:\\d+\\s+(?:men(?:'s)?\\s+)?spots?|men(?:'s)?(?:\\s+spots?)?\\s*[:\\-]?\\s*\\d+)\\b/i",
  "  );",
  "  const eventSection = spotIndex >= 0 ? searchFrom.slice(0, spotIndex) : searchFrom;",
  "  const timeMatches = [",
  "    ...eventSection.matchAll(/\\b(\\d{1,2}:\\d{2})\\s*(am|pm)\\b/gi),",
  "  ];",
  "  const timeMatch = timeMatches.at(-1) ?? null;",
  "  const time = timeMatch",
  "    ? normalizeTime(timeMatch[1] + \" \" + timeMatch[2])",
  "    : \"Unknown time\";",
  "",
  "  let location = timeMatch",
  "    ? normalizeText(eventSection.slice(0, timeMatch.index))",
  "    : \"\";",
  "",
  "  const neighborhood = normalizeText(header?.[2] ?? \"\");",
  "",
  "  location = location",
  "    .replace(/\\b(?:today|tomorrow)\\b/gi, \"\")",
  "    .replace(/\\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\s+[A-Z][a-z]{2}\\s+\\d{1,2}\\b/gi, \"\")",
  "    .replace(/\\b\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?\\b/g, \"\")",
  "    .replace(/\\bprogram cover image\\b/gi, \"\")",
  "    .replace(/\\bdrop[\\s-]*in\\b/gi, \"\")",
  "    .replace(/^(?:at|in)\\s+/i, \"\")",
  "    .replace(/\\s+/g, \" \")",
  "    .trim();",
  "",
  "  if (",
  "    neighborhood &&",
  "    location.toLowerCase().startsWith(neighborhood.toLowerCase())",
  "  ) {",
  "    location = normalizeText(location.slice(neighborhood.length));",
  "  }",
  "",
  "  const dashSegments = location",
  "    .split(/\\s+-\\s+/)",
  "    .map((segment) => normalizeText(segment))",
  "    .filter(Boolean);",
  "  if (dashSegments.length > 1) {",
  "    location = dashSegments.at(-1);",
  "  }",
  "",
  "  if (!location) location = \"Location unavailable\";",
  "",
  "  return {",
  "    day: titleCase(day),",
  "    time,",
  "    location: titleCase(location),",
  "  };",
  "}",
].join("\n");

source = source.slice(0, start) + replacement + source.slice(end);

const scrapeMarker = "async function scrapeMatches() {";
if (!source.includes("async function hasMensAvailability(")) {
  if (!source.includes(scrapeMarker)) {
    throw new Error("Could not locate scrapeMatches in monitor.mjs");
  }

  const mensAvailabilityHelper = [
    "async function hasMensAvailability(browser, rawUrl) {",
    "  const url = cleanUrl(rawUrl);",
    "  const parsed = new URL(url);",
    "",
    "  // A generic discovery page cannot prove which gender owns the open spot.",
    "  // Be conservative and do not alert unless the game page can be checked.",
    "  if (/\\/discover(?:\\/|$)/i.test(parsed.pathname)) {",
    "    console.log(\"Skipping unverified generic discovery URL: \" + url);",
    "    return false;",
    "  }",
    "",
    "  const detailsPage = await browser.newPage();",
    "  try {",
    "    await detailsPage.emulateTimezone(\"America/Denver\");",
    "    await detailsPage.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });",
    "    await detailsPage.setUserAgent(",
    "      \"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 \" +",
    "        \"(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\"",
    "    );",
    "",
    "    await detailsPage.setRequestInterception(true);",
    "    detailsPage.on(\"request\", (request) => {",
    "      const blockedTypes = new Set([\"image\", \"media\", \"font\"]);",
    "      if (blockedTypes.has(request.resourceType())) request.abort();",
    "      else request.continue();",
    "    });",
    "",
    "    await detailsPage.goto(url, {",
    "      waitUntil: \"domcontentloaded\",",
    "      timeout: 45_000,",
    "    });",
    "    await detailsPage.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => {});",
    "    await new Promise((resolve) => setTimeout(resolve, 1_500));",
    "",
    "    const pageText = await detailsPage.evaluate(() =>",
    "      String(document.body?.innerText ?? \"\").replace(/\\s+/g, \" \" ).trim()",
    "    );",
    "",
    "    const readCount = (patterns) => {",
    "      for (const pattern of patterns) {",
    "        const match = pageText.match(pattern);",
    "        if (match) return Number(match[1]);",
    "      }",
    "      return null;",
    "    };",
    "",
    "    const menCount = readCount([",
    "      /\\bmen(?:'s)?(?:\\s+only)?\\s*[:\\-]?\\s*(\\d+)\\b/i,",
    "      /\\b(\\d+)\\s+men(?:'s)?(?:\\s+only)?\\b/i,",
    "    ]);",
    "    const womenCount = readCount([",
    "      /\\bwomen(?:'s)?(?:\\s+only)?\\s*[:\\-]?\\s*(\\d+)\\b/i,",
    "      /\\b(\\d+)\\s+women(?:'s)?(?:\\s+only)?\\b/i,",
    "    ]);",
    "",
    "    if (menCount !== null) {",
    "      return menCount > 0;",
    "    }",
    "",
    "    // Example from Volo: \"Total Spot(s) Available 1 Women Only 1\".",
    "    // A positive women-only count with no men's count must never alert.",
    "    if (womenCount !== null && womenCount > 0) {",
    "      console.log(\"Skipping women-only availability: \" + url);",
    "      return false;",
    "    }",
    "",
    "    const totalCount = readCount([",
    "      /\\btotal spot\\(s\\) available\\s*[:\\-]?\\s*(\\d+)\\b/i,",
    "      /\\btotal spots? available\\s*[:\\-]?\\s*(\\d+)\\b/i,",
    "    ]);",
    "",
    "    // No gender restriction shown means the spot is available without a",
    "    // women-only limitation and can be treated as available to a man.",
    "    if (totalCount !== null) return totalCount > 0;",
    "",
    "    console.log(\"Could not verify men's availability: \" + url);",
    "    return false;",
    "  } finally {",
    "    await detailsPage.close();",
    "  }",
    "}",
    "",
  ].join("\n");

  source = source.replace(scrapeMarker, mensAvailabilityHelper + scrapeMarker);
}

const idMarker = "      const id = stableId(match);";
const mensCheck = [
  "      if (!(await hasMensAvailability(browser, match.url))) {",
  "        console.log(",
  "          \"Skipping listing without a verified men's spot: \" +",
  "            match.day + \" | \" + match.time + \" | \" + match.location",
  "        );",
  "        continue;",
  "      }",
  "",
  idMarker,
].join("\n");

if (!source.includes("Skipping listing without a verified men's spot:")) {
  if (!source.includes(idMarker)) {
    throw new Error("Could not locate match ID creation in monitor.mjs");
  }
  source = source.replace(idMarker, mensCheck);
}

await writeFile(path, source, "utf8");
console.log("Applied Denver timezone, event parsing, and men's-spot verification fixes.");
