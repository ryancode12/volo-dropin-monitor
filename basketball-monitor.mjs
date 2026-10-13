import puppeteer from "puppeteer-core";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseVoloGameInventory } from "./volo-inventory-parser.mjs";

const STATE_PATH = "state.json";
const VOLO_URL =
  "https://www.volosports.com/discover/denver?category=daily-sports&programType=dropin&sports=basketball";
const NTFY_TOPIC = requiredEnv("NTFY_TOPIC");
const VOLO_EMAIL = requiredEnv("VOLO_EMAIL");
const VOLO_PASSWORD = requiredEnv("VOLO_PASSWORD");
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truncate(value, max = 360) {
  const text = normalizeText(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function normalizeTime(value) {
  return normalizeText(value).replace(/\s+/g, "").toLowerCase();
}

function cleanUrl(rawUrl) {
  const url = new URL(rawUrl, VOLO_URL);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || ["fbclid", "gclid", "_gl"].includes(lower)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

function stableId(match) {
  const url = cleanUrl(match.url);
  const parsed = new URL(url);
  const identity = /discover/i.test(parsed.pathname)
    ? `${match.day}|${match.time}|${match.location}`
    : url;
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

function parseEventDetails(text) {
  const normalized = normalizeText(text);
  const dayMatch = normalized.match(
    /\b(Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\b/i
  );
  const dayNames = {
    mon: "Monday",
    monday: "Monday",
    tue: "Tuesday",
    tuesday: "Tuesday",
    wed: "Wednesday",
    wednesday: "Wednesday",
    thu: "Thursday",
    thursday: "Thursday",
    fri: "Friday",
    friday: "Friday",
    sat: "Saturday",
    saturday: "Saturday",
    sun: "Sunday",
    sunday: "Sunday",
  };
  const day = dayMatch
    ? dayNames[dayMatch[1].toLowerCase()] || dayMatch[1]
    : "Unknown day";

  const rangeMatch = normalized.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[–—-]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i
  );
  const singleTime = normalized.match(
    /\b(\d{1,2})(?::(\d{2}))\s*(am|pm)\b/i
  );

  let time = "Unknown time";
  if (rangeMatch) {
    let startMeridiem = (rangeMatch[3] || "").toLowerCase();
    const endMeridiem = rangeMatch[6].toLowerCase();
    const startHour = Number(rangeMatch[1]);
    const endHour = Number(rangeMatch[4]);
    if (!startMeridiem) {
      startMeridiem = endMeridiem;
      if (endMeridiem === "pm" && startHour > endHour) startMeridiem = "am";
      if (endMeridiem === "am" && startHour > endHour) startMeridiem = "pm";
    }
    time = normalizeTime(
      `${startHour}:${rangeMatch[2] || "00"}${startMeridiem}`
    );
  } else if (singleTime) {
    time = normalizeTime(
      `${singleTime[1]}:${singleTime[2]}${singleTime[3]}`
    );
  }

  const dateMatch = normalized.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/);
  let location = "";
  if (dateMatch) {
    const beforeDate = normalizeText(normalized.slice(0, dateMatch.index));
    const segments = beforeDate
      .split(/\s+-\s+/)
      .map((part) => normalizeText(part))
      .filter(Boolean);
    location = segments.at(-1) || "";
  }

  location = location
    .replace(/\b(?:today|tomorrow)\b/gi, "")
    .replace(/^(?:at|in)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!location || /^(?:basketball|drop[ -]?in|daily sports)$/i.test(location)) {
    location = "Location available on Volo";
  }

  return { day, time, location };
}

async function readRootState() {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeRootState(root) {
  await writeFile(STATE_PATH, `${JSON.stringify(root, null, 2)}\n`, "utf8");
}

function normalizeBasketballState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    initialized: Boolean(state.initialized),
    current: Array.isArray(state.current) ? state.current : [],
    lastErrorDate: state.lastErrorDate ?? null,
  };
}

async function sendNotification({
  title,
  message,
  click = VOLO_URL,
  priority = "5",
  tags = "basketball,rotating_light",
}) {
  const response = await fetch(
    `https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Title: title,
        Priority: priority,
        Tags: tags,
        Click: click,
      },
      body: message,
    }
  );

  if (!response.ok) {
    throw new Error(
      `ntfy returned HTTP ${response.status}: ${await response.text()}`
    );
  }
}

async function firstExistingSelector(page, selectors) {
  for (const selector of selectors) {
    if (await page.$(selector)) return selector;
  }
  return null;
}

async function loginToVolo(page) {
  await page.goto("https://www.volosports.com/login", {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  await page
    .waitForNetworkIdle({ idleTime: 750, timeout: 20_000 })
    .catch(() => {});

  const emailSelector = await firstExistingSelector(page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[autocomplete="username"]',
  ]);
  const passwordSelector = await firstExistingSelector(page, [
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]',
  ]);

  if (!emailSelector || !passwordSelector) {
    throw new Error(
      "Could not find Volo login fields for authenticated basketball monitoring."
    );
  }

  await page.click(emailSelector, { clickCount: 3 });
  await page.type(emailSelector, VOLO_EMAIL, { delay: 10 });
  await page.click(passwordSelector, { clickCount: 3 });
  await page.type(passwordSelector, VOLO_PASSWORD, { delay: 10 });

  const navigation = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45_000 })
    .catch(() => null);

  const clicked = await page.evaluate(() => {
    const normalize = (value) =>
      String(value ?? "").replace(/\s+/g, " ").trim();
    const controls = [
      ...document.querySelectorAll(
        'button, input[type="submit"], [role="button"]'
      ),
    ];
    const target = controls.find((element) =>
      /^(?:log in with email|log in|sign in)$/i.test(
        normalize(element.innerText || element.value || element.textContent)
      )
    );
    if (!target) return false;
    target.click();
    return true;
  });

  if (!clicked) await page.press(passwordSelector, "Enter");
  await navigation;
  await page
    .waitForNetworkIdle({ idleTime: 750, timeout: 20_000 })
    .catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  const status = await page.evaluate(() => ({
    url: location.href,
    body: String(document.body?.innerText ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  }));

  if (
    /\/login(?:\/|$|\?)/i.test(status.url) ||
    /incorrect|invalid|unable to log in|wrong password/i.test(status.body)
  ) {
    throw new Error(
      "Volo did not accept the stored login for authenticated basketball monitoring."
    );
  }

  console.log("Authenticated Volo session established for basketball monitoring.");
}

async function hasEligibleAvailability(browser, rawUrl, listingText = "") {
  const url = cleanUrl(rawUrl);
  const parsed = new URL(url);
  if (/\/discover(?:\/|$)/i.test(parsed.pathname)) {
    console.log("Basketball: skipping unverified generic discovery URL: " + url);
    return false;
  }

  const listing = normalizeText(listingText);
  const explicitlyWomensOnly =
    /\b(?:women(?:'s)?|female)\b/i.test(listing) &&
    !/\b(?:coed|open\s+gender|men(?:'s)?)\b/i.test(listing);
  if (explicitlyWomensOnly) {
    console.log("Basketball: skipping explicitly women's listing: " + url);
    return false;
  }

  const detailsPage = await browser.newPage();
  try {
    await detailsPage.emulateTimezone("America/Denver");
    await detailsPage.setViewport({
      width: 1440,
      height: 1200,
      deviceScaleFactor: 1,
    });
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
    await detailsPage
      .waitForNetworkIdle({ idleTime: 1_000, timeout: 25_000 })
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const detail = await detailsPage.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: String(document.body?.innerText ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    }));

    if (/\/login(?:\/|$|\?)/i.test(detail.url)) {
      throw new Error(
        "Authenticated basketball inventory check redirected to login."
      );
    }

    const inventory = parseVoloGameInventory(detail.text);
    console.log(
      "Authoritative Volo basketball inventory: " +
        JSON.stringify({
          url,
          total: inventory.total,
          men: inventory.men,
          anyGender: inventory.anyGender,
          openGender: inventory.openGender,
          womenOnly: inventory.womenOnly,
          eligible: inventory.eligible,
          source: inventory.source,
          listing: listing.slice(0, 180),
        })
    );

    if (inventory.eligible > 0) {
      console.log("Verified basketball spot available to a man: " + url);
      return true;
    }

    if ((inventory.womenOnly ?? 0) > 0) {
      console.log(
        "Skipping basketball inventory restricted to women/non-binary: " + url
      );
      return false;
    }

    if (
      inventory.total === 0 ||
      /\bsold\s+out\b/i.test(detail.text)
    ) {
      console.log("Skipping basketball game with no current inventory: " + url);
      return false;
    }

    console.log(
      "Could not verify a men's or any-gender basketball spot: " + url
    );
    return false;
  } finally {
    await detailsPage.close();
  }
}

async function scrapeMatches() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    timeout: 120_000,
    protocolTimeout: 300_000,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-background-networking",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.emulateTimezone("America/Denver");
    await page.setViewport({
      width: 1440,
      height: 1200,
      deviceScaleFactor: 1,
    });
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
    );
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const blockedTypes = new Set(["image", "media", "font"]);
      if (blockedTypes.has(request.resourceType())) request.abort();
      else request.continue();
    });

    await loginToVolo(page);
    await page.goto(VOLO_URL, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    await page
      .waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 })
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    await page
      .evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((element) =>
          /^(accept|accept all|allow all|agree)$/i.test(
            (element.textContent || "").trim()
          )
        );
        button?.click();
      })
      .catch(() => {});

    const result = await page.evaluate(() => {
      const normalize = (value) =>
        String(value ?? "").replace(/\s+/g, " ").trim();

      const availableSpots = (text) => {
        const match = text.match(/\b(\d+)\s+spots?\b/i);
        return match ? Number(match[1]) : null;
      };

      const nonmatchingMarker = [
        ...document.querySelectorAll("h1,h2,h3,h4,h5,p,div"),
      ].find((element) => {
        const text = normalize(element.textContent);
        return (
          text.length < 180 &&
          /don['’]t match all (?:of )?your filters/i.test(text)
        );
      });

      const isVisible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const looksRelevant = (text) => {
        const spots = availableSpots(text);
        return (
          /\bbasketball\b/i.test(text) &&
          /\bdrop[\s-]*in\b/i.test(text) &&
          spots !== null &&
          spots > 0 &&
          !/\b(?:sold out|full|waitlist only)\b/i.test(text) &&
          /(?:\b(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[–—-]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b)/i.test(
            text
          )
        );
      };

      const matchingElements = [...document.querySelectorAll("body *")]
        .filter(isVisible)
        .map((element) => ({
          element,
          text: normalize(element.innerText || element.textContent),
        }))
        .filter(({ element, text }) => {
          if (text.length < 20 || text.length > 1_200 || !looksRelevant(text)) {
            return false;
          }

          if (
            nonmatchingMarker &&
            (nonmatchingMarker.compareDocumentPosition(element) &
              Node.DOCUMENT_POSITION_FOLLOWING)
          ) {
            return false;
          }

          return !element.closest(
            '[id*="nonmatch" i], [class*="nonmatch" i], ' +
              '[id*="suggest" i], [class*="suggest" i]'
          );
        });

      const cardElements = matchingElements.filter(
        ({ element, text }) =>
          !matchingElements.some(
            ({ element: other, text: otherText }) =>
              other !== element &&
              element.contains(other) &&
              otherText.length < text.length
          )
      );

      const candidates = [];
      const seen = new Set();

      for (const { element: cardNode, text: cardText } of cardElements) {
        if (seen.has(cardText)) continue;
        seen.add(cardText);

        const links = [
          ...(cardNode.matches("a[href]") ? [cardNode] : []),
          ...cardNode.querySelectorAll("a[href]"),
        ];

        const link = links
          .filter((candidate) => candidate.href)
          .sort((a, b) => {
            const score = (candidate) => {
              const linkText = normalize(
                candidate.innerText || candidate.textContent
              );
              let value = 0;
              if (/\/(?:d|game)\/[0-9a-f-]{20,}/i.test(candidate.href)) {
                value += 30;
              }
              if (/\b(?:register|sign up|join|claim|details|view)\b/i.test(linkText)) {
                value += 20;
              }
              if (!/\/discover(?:\/|$|\?)/i.test(candidate.href)) {
                value += 4;
              }
              return value;
            };
            return score(b) - score(a);
          })[0];

        candidates.push({
          title: cardText,
          url: link?.href || location.href,
          spots: availableSpots(cardText),
        });
      }

      return {
        pageTitle: document.title,
        finalUrl: location.href,
        bodyText: normalize(document.body?.innerText).slice(0, 20_000),
        candidates,
      };
    });

    if (/you need to enable javascript/i.test(result.bodyText)) {
      throw new Error("Volo did not render in the headless browser.");
    }
    if (result.bodyText.length < 100) {
      throw new Error(
        `Volo returned an unexpectedly empty basketball page: ${result.finalUrl}`
      );
    }

    const deduplicated = new Map();

    for (const candidate of result.candidates) {
      const details = parseEventDetails(candidate.title);
      const match = {
        title: truncate(candidate.title),
        day: details.day,
        time: details.time,
        location: details.location,
        url: cleanUrl(candidate.url || result.finalUrl),
        spots: Number(candidate.spots),
      };

      if (!(await hasEligibleAvailability(browser, match.url, match.title))) {
        console.log(
          "Skipping basketball listing without a verified men's or any-gender spot: " +
            `${match.day} | ${match.time} | ${match.location}`
        );
        continue;
      }

      const id = stableId(match);
      if (!deduplicated.has(id)) {
        deduplicated.set(id, { id, ...match });
      }
    }

    const matches = [...deduplicated.values()].sort((a, b) =>
      `${a.day}|${a.time}|${a.location}`.localeCompare(
        `${b.day}|${b.time}|${b.location}`
      )
    );

    console.log(
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          sport: "basketball",
          pageTitle: result.pageTitle,
          finalUrl: result.finalUrl,
          matches,
          pagePreview: result.bodyText.slice(0, 1_500),
        },
        null,
        2
      )
    );

    return matches;
  } finally {
    await browser.close();
  }
}

async function scrapeMatchesWithRetry(attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await scrapeMatches();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Basketball scrape attempt ${attempt}/${attempts} failed: ${message}`
      );
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
      }
    }
  }
  throw lastError ?? new Error("Basketball monitor scrape failed after retries.");
}

async function main() {
  const root = await readRootState();
  const state = normalizeBasketballState(root.basketball);
  const today = new Date().toISOString().slice(0, 10);

  try {
    const matches = await scrapeMatchesWithRetry();
    const oldIds = new Set(state.current.map((item) => item.id));
    const newMatches = matches.filter((item) => !oldIds.has(item.id));

    if (!state.initialized && matches.length === 0) {
      await sendNotification({
        title: "Volo basketball monitor active",
        message:
          "The basketball monitor is running. No eligible basketball drop-ins are visible right now.",
        priority: "3",
        tags: "white_check_mark,basketball",
      });
    }

    for (const match of newMatches) {
      await sendNotification({
        title: "Volo basketball drop-in available",
        message: `${match.day}, ${match.time}, ${match.location}`,
        click: match.url,
      });
    }

    state.initialized = true;
    state.current = matches;
    state.lastErrorDate = null;
    root.basketball = state;
    await writeRootState(root);

    console.log(
      `Basketball current matches: ${matches.length}; new alerts sent: ${newMatches.length}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);

    if (state.lastErrorDate !== today) {
      try {
        await sendNotification({
          title: "Volo basketball monitor needs attention",
          message: `The basketball monitor failed: ${truncate(message, 280)}`,
          priority: "4",
          tags: "warning,basketball",
        });
        state.lastErrorDate = today;
      } catch (notificationError) {
        console.error(
          "Could not send the basketball failure notification:",
          notificationError
        );
      }
    }

    root.basketball = state;
    await writeRootState(root);
    process.exitCode = 1;
  }
}

await main();
