import puppeteer from "puppeteer-core";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const STATE_PATH = "pickleball-state.json";
const PICKLEBALL_URL =
  process.env.PICKLEBALL_URL?.trim() ||
  "https://www.volosports.com/discover/denver?category=daily-sports&programType=pickups&sports=pickleball&venues=club-volo-sobo-indoor";
const NTFY_TOPIC = requiredEnv("NTFY_TOPIC");
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const TIMEZONE = "America/Denver";
const VENUE = "Club Volo SoBo - Indoor";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cleanUrl(rawUrl) {
  const url = new URL(rawUrl, PICKLEBALL_URL);
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
    ? `${event.day}|${event.time}|${event.location}|${event.capacity}`
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
      lastErrorDate: state.lastErrorDate ?? null,
    };
  } catch {
    return { initialized: false, current: [], lastErrorDate: null };
  }
}

async function writeState(state) {
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function sendNotification({ title, message, click, priority = "5", tags = "rotating_light" }) {
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

function parseCard(text) {
  const normalized = normalizeText(text);
  const playing = /\b(\d+)\s*\/\s*(\d+)\s*playing\b/i.exec(normalized);
  if (!playing) return null;

  const registered = Number(playing[1]);
  const capacity = Number(playing[2]);
  const remaining = capacity - registered;

  const datedStart = /(?:\bToday\b|\bTomorrow\b|\b\d{1,2}\/\d{1,2}\b)\s*-\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i.exec(
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
    registered,
    capacity,
    remaining,
  };
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
    const page = await browser.newPage();
    await page.emulateTimezone(TIMEZONE);
    await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
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

    await page.goto(PICKLEBALL_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const result = await page.evaluate(() => {
      const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
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
      const relevant = (text) =>
        /\bpickleball\b/i.test(text) &&
        /\bpickup\b/i.test(text) &&
        /club\s+volo\s+sobo\s*-?\s*indoor/i.test(text) &&
        /\b\d+\s*\/\s*\d+\s*playing\b/i.test(text);
      const badLink = (href) =>
        !href ||
        /\/(?:legal|terms|privacy|accessibility|about|contact)(?:\/|$|\?)/i.test(href);

      const matches = [...document.querySelectorAll("body *")]
        .filter(isVisible)
        .map((element) => ({
          element,
          text: normalize(element.innerText || element.textContent),
        }))
        .filter(({ text }) => text.length >= 20 && text.length <= 1_500 && relevant(text));

      const smallest = matches.filter(
        ({ element, text }) =>
          !matches.some(
            ({ element: other, text: otherText }) =>
              other !== element && element.contains(other) && otherText.length < text.length
          )
      );

      const cards = [];
      const seen = new Set();
      for (const { element, text } of smallest) {
        if (seen.has(text)) continue;
        seen.add(text);
        const links = [
          ...(element.matches("a[href]") ? [element] : []),
          ...element.querySelectorAll("a[href]"),
        ];
        const link = links
          .filter((candidate) => !badLink(candidate.href))
          .sort((a, b) => {
            const score = (candidate) => {
              let value = 0;
              if (/\/game\//i.test(candidate.href)) value += 20;
              if (!/\/discover(?:\/|$|\?)/i.test(candidate.href)) value += 5;
              return value;
            };
            return score(b) - score(a);
          })[0];
        cards.push({ text, url: link?.href || location.href });
      }

      return {
        finalUrl: location.href,
        bodyText: normalize(document.body?.innerText).slice(0, 20_000),
        cards,
      };
    });

    if (/you need to enable javascript/i.test(result.bodyText)) {
      throw new Error("Volo pickleball page did not render in the headless browser.");
    }

    const events = new Map();
    for (const card of result.cards) {
      const details = parseCard(card.text);
      if (!details || details.remaining < 1 || details.remaining > 2) continue;
      const event = {
        ...details,
        url: cleanUrl(card.url || result.finalUrl),
      };
      const id = eventId(event);
      if (!events.has(id)) events.set(id, { id, ...event });
    }
    return [...events.values()];
  } finally {
    await browser.close();
  }
}

async function main() {
  const state = await readState();
  const today = new Date().toISOString().slice(0, 10);

  try {
    const events = await scrapePickleball();
    const oldIds = new Set(state.current.map((item) => item.id));
    const newEvents = events.filter((item) => !oldIds.has(item.id));

    for (const event of newEvents) {
      await sendNotification({
        title: "Pickleball pickup almost full",
        message: `${event.day}, ${event.time}, ${event.location} — ${event.remaining} ${event.remaining === 1 ? "spot" : "spots"} left`,
        click: event.url,
      });
    }

    state.initialized = true;
    state.current = events;
    state.lastErrorDate = null;
    await writeState(state);

    console.log(
      `Pickleball pickups with 1-2 spots left: ${events.length}; new alerts sent: ${newEvents.length}`
    );
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), events }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    if (state.lastErrorDate !== today) {
      try {
        await sendNotification({
          title: "Pickleball monitor needs attention",
          message: `The pickleball monitor failed: ${normalizeText(message).slice(0, 280)}`,
          click: PICKLEBALL_URL,
          priority: "4",
          tags: "warning",
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
