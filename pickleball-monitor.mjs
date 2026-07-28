import puppeteer from "puppeteer-core";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const STATE_PATH = "pickleball-state.json";
const DISCOVER_URL =
  process.env.PICKLEBALL_URL?.trim() ||
  "https://www.volosports.com/discover/denver?category=daily-sports&programType=pickups&sports=pickleball&venues=club-volo-sobo-indoor";
const PICKLEBALL_LANDING_URL = "https://www.volosports.com/denver/pickleball";
const NTFY_TOPIC = requiredEnv("NTFY_TOPIC");
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const TIMEZONE = "America/Denver";
const VENUE = "Club Volo SoBo - Indoor";
const TEST_MODE = /^(?:1|true|yes)$/i.test(process.env.PICKLEBALL_TEST_MODE ?? "");
const SOURCE_URLS = [...new Set([DISCOVER_URL, PICKLEBALL_LANDING_URL])];

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanUrl(rawUrl) {
  const url = new URL(rawUrl, DISCOVER_URL);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || ["fbclid", "gclid", "_gl"].includes(lower)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

function normalizeTime(value) {
  const compact = normalizeText(value).replace(/\s+/g, "").toLowerCase();
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(compact);
  if (!match) return compact || "Unknown time";
  return `${Number(match[1])}:${match[2] ?? "00"}${match[3]}`;
}

function titleCase(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function eventId(event) {
  const parsed = new URL(event.url);
  const identity = /\/discover(?:\/|$)/i.test(parsed.pathname)
    ? `${event.day}|${event.time}|${event.location}|${event.capacity ?? "unknown"}`
    : event.url;
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `pickleball:${hash}`;
}

async function readState() {
  try {
    const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
    return {
      initialized: Boolean(state.initialized),
      current: Array.isArray(state.current) ? state.current : [],
      alerted: Array.isArray(state.alerted) ? state.alerted : [],
      lastErrorDate: state.lastErrorDate ?? null,
    };
  } catch {
    return { initialized: false, current: [], alerted: [], lastErrorDate: null };
  }
}

async function writeState(state) {
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function sendNotification({
  title,
  message,
  click,
  priority = "5",
  tags = "pickle,rotating_light",
}) {
  const response = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Title: title,
      Priority: priority,
      Tags: tags,
      Click: click,
    },
    body: message,
  });
  if (!response.ok) {
    throw new Error(`ntfy returned HTTP ${response.status}: ${await response.text()}`);
  }
}

function denverDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "long",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function tomorrowWeekday() {
  return denverDateParts(new Date(Date.now() + 24 * 60 * 60 * 1000)).weekday;
}

function weekdayForMonthDay(month, day) {
  const current = denverDateParts();
  let year = Number(current.year);
  const currentDate = Date.UTC(year, Number(current.month) - 1, Number(current.day), 18);
  let candidate = Date.UTC(year, month - 1, day, 18);
  if (candidate < currentDate - 120 * 24 * 60 * 60 * 1000) {
    year += 1;
    candidate = Date.UTC(year, month - 1, day, 18);
  }
  return denverDateParts(new Date(candidate)).weekday;
}

function parseAvailability(text) {
  const normalized = normalizeText(text);

  const playing = /\b(\d+)\s*\/\s*(\d+)\s*(?:playing|registered|players?)\b/i.exec(
    normalized
  );
  if (playing) {
    const registered = Number(playing[1]);
    const capacity = Number(playing[2]);
    return {
      registered,
      capacity,
      remaining: Math.max(0, capacity - registered),
      availabilitySource: `${registered}/${capacity} playing`,
    };
  }

  const ratio = /\b(\d+)\s*\/\s*(\d+)\b/.exec(normalized);
  if (ratio) {
    const registered = Number(ratio[1]);
    const capacity = Number(ratio[2]);
    if (capacity >= registered && capacity >= 4) {
      return {
        registered,
        capacity,
        remaining: capacity - registered,
        availabilitySource: `${registered}/${capacity}`,
      };
    }
  }

  const spotsLeft = /\b(\d+)\s+spots?\s+(?:left|remaining|available)\b/i.exec(normalized);
  if (spotsLeft) {
    return {
      registered: null,
      capacity: null,
      remaining: Number(spotsLeft[1]),
      availabilitySource: spotsLeft[0],
    };
  }

  return null;
}

function parseCard(text) {
  const normalized = normalizeText(text);
  const availability = parseAvailability(normalized);
  if (!availability) return null;

  const datedStart = /(?:\bToday\b|\bTomorrow\b|\b\d{1,2}\/\d{1,2}\b)\s*(?:[·-]|at)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i.exec(
    normalized
  );
  const allTimes = [
    ...normalized.matchAll(/\b(\d{1,2}(?::\d{2})?)\s*(am|pm)\b/gi),
  ];
  const fallbackStart = allTimes.length >= 2 ? allTimes.at(-2) : allTimes.at(0);
  const time = datedStart
    ? normalizeTime(datedStart[1])
    : fallbackStart
      ? normalizeTime(`${fallbackStart[1]}${fallbackStart[2]}`)
      : "Unknown time";

  const weekday = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.exec(
    normalized
  )?.[1];
  const dateMatch = /\b(\d{1,2})\/(\d{1,2})\b/.exec(normalized);
  let day = weekday ? titleCase(weekday) : null;
  if (!day && /\bTomorrow\b/i.test(normalized)) day = tomorrowWeekday();
  if (!day && /\bToday\b/i.test(normalized)) day = denverDateParts().weekday;
  if (!day && dateMatch) {
    day = weekdayForMonthDay(Number(dateMatch[1]), Number(dateMatch[2]));
  }

  return {
    day: day || "Unknown day",
    time,
    location: VENUE,
    ...availability,
  };
}

async function configurePage(page) {
  await page.emulateTimezone(TIMEZONE);
  await page.setViewport({ width: 1440, height: 1400, deviceScaleFactor: 1 });
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
  );
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (new Set(["image", "media", "font"]).has(request.resourceType())) {
      request.abort();
    } else {
      request.continue();
    }
  });
}

async function scrollForLazyCards(page) {
  await page.evaluate(async () => {
    for (let step = 0; step < 10; step += 1) {
      window.scrollBy(0, Math.max(window.innerHeight * 0.8, 700));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    window.scrollTo(0, 0);
  });
}

async function scrapeSource(browser, sourceUrl) {
  const page = await browser.newPage();
  try {
    await configurePage(page);
    await page.goto(sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => {});
    await page
      .waitForFunction(
        () => /pickleball/i.test(document.body?.innerText ?? ""),
        { timeout: 15_000 }
      )
      .catch(() => {});
    await scrollForLazyCards(page);
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    return await page.evaluate(() => {
      const normalize = (value) =>
        String(value ?? "")
          .replace(/[\u2010-\u2015]/g, "-")
          .replace(/\s+/g, " ")
          .trim();
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
      const hasAvailability = (text) =>
        /\b\d+\s*\/\s*\d+\s*(?:playing|registered|players?)\b/i.test(text) ||
        /\b\d+\s+spots?\s+(?:left|remaining|available)\b/i.test(text);
      const relevant = (text) =>
        /\bpickleball\b/i.test(text) &&
        /\bpickup\b/i.test(text) &&
        /club\s+volo\s+sobo\s*-?\s*indoor/i.test(text) &&
        hasAvailability(text);
      const badLink = (href) =>
        !href ||
        /\/(?:legal|terms|privacy|accessibility|about|contact)(?:\/|$|\?)/i.test(href);

      const all = [...document.querySelectorAll("body *")]
        .filter(isVisible)
        .map((element) => ({
          element,
          text: normalize(element.innerText || element.textContent),
        }))
        .filter(({ text }) => text.length >= 20 && text.length <= 2_500 && relevant(text));

      const smallest = all.filter(
        ({ element, text }) =>
          !all.some(
            ({ element: other, text: otherText }) =>
              other !== element &&
              element.contains(other) &&
              otherText.length < text.length &&
              relevant(otherText)
          )
      );

      const cards = [];
      const seen = new Set();
      for (const { element, text } of smallest) {
        if (seen.has(text)) continue;
        seen.add(text);

        let linkContainer = element;
        for (
          let depth = 0;
          depth < 4 && linkContainer && !linkContainer.querySelector?.("a[href]");
          depth += 1
        ) {
          linkContainer = linkContainer.parentElement;
        }
        const links = [
          ...(element.matches("a[href]") ? [element] : []),
          ...element.querySelectorAll("a[href]"),
          ...(linkContainer && linkContainer !== element
            ? linkContainer.querySelectorAll("a[href]")
            : []),
        ];
        const link = [...new Set(links)]
          .filter((candidate) => !badLink(candidate.href))
          .sort((a, b) => {
            const score = (candidate) => {
              let value = 0;
              if (/\/game\//i.test(candidate.href)) value += 30;
              if (/\b(?:register|details|view|pickup)\b/i.test(normalize(candidate.innerText))) {
                value += 10;
              }
              if (!/\/discover(?:\/|$|\?)/i.test(candidate.href)) value += 5;
              return value;
            };
            return score(b) - score(a);
          })[0];
        cards.push({ text, url: link?.href || location.href });
      }

      return {
        sourceUrl: location.href,
        bodyPreview: normalize(document.body?.innerText).slice(0, 2_000),
        cards,
      };
    });
  } finally {
    await page.close();
  }
}

async function scrapePickleball() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
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
    const results = [];
    for (const sourceUrl of SOURCE_URLS) {
      try {
        results.push(await scrapeSource(browser, sourceUrl));
      } catch (error) {
        console.error(`Pickleball source failed (${sourceUrl}):`, error);
      }
    }

    if (results.length === 0) {
      throw new Error("Every pickleball source failed.");
    }

    const allEvents = new Map();
    for (const result of results) {
      for (const card of result.cards) {
        const details = parseCard(card.text);
        if (!details) continue;
        const event = {
          ...details,
          url: cleanUrl(card.url || result.sourceUrl),
        };
        const id = eventId(event);
        if (!allEvents.has(id)) allEvents.set(id, { id, ...event });
      }
    }

    const all = [...allEvents.values()];
    const qualifying = all.filter((event) => event.remaining >= 1 && event.remaining <= 2);

    console.log(
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          sourceSummaries: results.map((result) => ({
            sourceUrl: result.sourceUrl,
            candidateCards: result.cards.length,
            bodyPreview: result.bodyPreview,
          })),
          allPickups: all,
          qualifying,
        },
        null,
        2
      )
    );

    return { all, qualifying };
  } finally {
    await browser.close();
  }
}

async function main() {
  const state = await readState();
  const today = new Date().toISOString().slice(0, 10);

  try {
    const { all, qualifying } = await scrapePickleball();
    const alertedIds = new Set(state.alerted.map((item) => item.id));
    const newEvents = qualifying.filter((item) => !alertedIds.has(item.id));

    for (const event of newEvents) {
      await sendNotification({
        title: "Pickleball pickup almost full",
        message: `${event.day}, ${event.time}, ${event.location} — ${event.remaining} ${event.remaining === 1 ? "spot" : "spots"} left`,
        click: event.url,
      });
    }

    if (TEST_MODE) {
      const closest = [...all]
        .filter((event) => event.remaining > 0)
        .sort((a, b) => a.remaining - b.remaining)[0];
      await sendNotification({
        title: "Pickleball monitor test",
        message: closest
          ? `Detected ${all.length} SoBo pickup(s). Closest: ${closest.day}, ${closest.time} — ${closest.remaining} spots left (${closest.availabilitySource}).`
          : "The monitor ran, but it did not detect any Club Volo SoBo - Indoor pickup cards.",
        click: closest?.url || DISCOVER_URL,
        priority: "3",
        tags: "white_check_mark,pickle",
      });
    }

    const now = new Date().toISOString();
    const newAlerted = newEvents.map((event) => ({ id: event.id, alertedAt: now }));
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    state.alerted = [...state.alerted, ...newAlerted].filter(
      (item) => !item.alertedAt || Date.parse(item.alertedAt) >= cutoff
    );
    state.initialized = true;
    state.current = qualifying;
    state.lastErrorDate = null;
    await writeState(state);

    console.log(
      `Pickleball cards detected: ${all.length}; pickups with 1-2 spots left: ${qualifying.length}; new alerts sent: ${newEvents.length}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    if (state.lastErrorDate !== today) {
      try {
        await sendNotification({
          title: "Pickleball monitor needs attention",
          message: `The pickleball monitor failed: ${normalizeText(message).slice(0, 280)}`,
          click: DISCOVER_URL,
          priority: "4",
          tags: "warning,pickle",
        });
        state.lastErrorDate = today;
      } catch (notificationError) {
        console.error("Could not send the pickleball failure notification:", notificationError);
      }
    }
    await writeState(state);
    process.exitCode = 1;
  }
}

await main();
