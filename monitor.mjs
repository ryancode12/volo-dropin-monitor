import puppeteer from "puppeteer-core";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const STATE_PATH = "state.json";
const VOLO_URL = requiredEnv("VOLO_URL");
const NTFY_TOPIC = requiredEnv("NTFY_TOPIC");
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

function stripChangingAvailability(text) {
  return normalizeText(text)
    .replace(/\b\d+\s+(?:men(?:'s)?\s+|women(?:'s)?\s+)?spots?\b/gi, "")
    .replace(/\b(?:men|women)(?:'s)?(?:\s+spots?)?\s*[:\-]?\s*\d+\b/gi, "")
    .replace(/\b\d+\s+(?:men|women)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stableId(match) {
  const url = cleanUrl(match.url);
  const parsed = new URL(url);
  const identity = /discover/i.test(parsed.pathname)
    ? `${stripChangingAvailability(match.title)}|${url}`
    : url;
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

async function readState() {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const state = JSON.parse(raw);
    return {
      initialized: Boolean(state.initialized),
      current: Array.isArray(state.current) ? state.current : [],
      lastErrorDate: state.lastErrorDate ?? null,
      keepaliveMonth: state.keepaliveMonth ?? null,
    };
  } catch {
    return {
      initialized: false,
      current: [],
      lastErrorDate: null,
      keepaliveMonth: null,
    };
  }
}

async function writeState(state) {
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function sendNotification({
  title,
  message,
  click = VOLO_URL,
  priority = "5",
  tags = "soccer,rotating_light",
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

async function scrapeMatches() {
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
    await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
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

    await page.goto(VOLO_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });

    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // Dismiss a cookie banner when one exists.
    await page
      .evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((element) =>
          /^(accept|accept all|allow all|agree)$/i.test((element.textContent || "").trim())
        );
        button?.click();
      })
      .catch(() => {});

    const result = await page.evaluate(() => {
      const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

      const availableSpots = (text) => {
        const patterns = [
          /\b(\d+)\s+(?:men(?:'s)?\s+)?spots?\b/i,
          /\bmen(?:'s)?(?:\s+spots?)?\s*[:\-]?\s*(\d+)\b/i,
        ];

        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match) return Number(match[1]);
        }
        return null;
      };

      // Volo may show a second section containing recommendations that fail
      // one or more filters. Never alert from that section.
      const nonmatchingMarker = [
        ...document.querySelectorAll("h1,h2,h3,h4,h5,p,div"),
      ].find((element) => {
        const text = normalize(element.textContent);
        return (
          text.length < 180 &&
          /don['’]t match all (?:of )?your filters/i.test(text)
        );
      });

      const candidates = [];
      const interactiveElements = [
        ...document.querySelectorAll(
          'a[href], button, [role="link"], [role="button"]'
        ),
      ];

      for (const element of interactiveElements) {
        if (
          nonmatchingMarker &&
          (nonmatchingMarker.compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_FOLLOWING)
        ) {
          continue;
        }

        const excludedContainer = element.closest(
          '[id*="nonmatch" i], [class*="nonmatch" i], ' +
            '[id*="suggest" i], [class*="suggest" i]'
        );
        if (excludedContainer) continue;

        let cardText = "";
        let node = element;

        for (
          let depth = 0;
          node && depth < 8;
          depth += 1, node = node.parentElement
        ) {
          const text = normalize(node.innerText || node.textContent);
          const spots = availableSpots(text);

          const looksRelevant =
            /\bsoccer\b/i.test(text) &&
            /\bdrop[\s-]*in\b/i.test(text) &&
            spots !== null &&
            spots > 0 &&
            !/\b(?:sold out|full|waitlist only)\b/i.test(text) &&
            /(?:\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b|\b\d{1,2}:\d{2}\s*(?:am|pm)\b)/i.test(
              text
            );

          if (looksRelevant && text.length >= 20 && text.length <= 1_200) {
            cardText = text;
            break;
          }
        }

        if (!cardText) continue;

        const link =
          (element.matches("a[href]") && element) ||
          element.closest("a[href]") ||
          element.querySelector("a[href]");

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
      throw new Error(`Volo returned an unexpectedly empty page: ${result.finalUrl}`);
    }

    const deduplicated = new Map();

    for (const candidate of result.candidates) {
      const match = {
        title: truncate(candidate.title),
        url: cleanUrl(candidate.url || result.finalUrl),
        spots: Number(candidate.spots),
      };
      const id = stableId(match);
      if (!deduplicated.has(id)) {
        deduplicated.set(id, { id, ...match });
      }
    }

    const matches = [...deduplicated.values()].sort((a, b) =>
      a.title.localeCompare(b.title)
    );

    // This output appears in the GitHub Actions log and is useful if Volo
    // changes its page structure.
    console.log(
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
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

async function main() {
  const state = await readState();
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  try {
    const matches = await scrapeMatches();
    const oldIds = new Set(state.current.map((item) => item.id));
    const newMatches = matches.filter((item) => !oldIds.has(item.id));

    // A one-time confirmation proves the workflow and phone notifications work.
    if (!state.initialized && matches.length === 0) {
      await sendNotification({
        title: "Volo monitor active",
        message:
          "The monitor is running. No matching soccer drop-ins are visible right now.",
        priority: "3",
        tags: "white_check_mark,soccer",
      });
    }

    for (const match of newMatches) {
      await sendNotification({
        title: "Volo soccer drop-in available",
        message: `${match.title}\n\nOpen Volo now to claim the spot.`,
        click: match.url,
      });
    }

    state.initialized = true;
    state.current = matches;
    state.lastErrorDate = null;

    // Produces one harmless state commit per month so GitHub does not classify
    // the public repository as inactive and disable its scheduled workflow.
    state.keepaliveMonth = month;

    await writeState(state);
    console.log(
      `Current matches: ${matches.length}; new alerts sent: ${newMatches.length}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);

    // Avoid spamming your phone if Volo is temporarily down or changes its HTML.
    if (state.lastErrorDate !== today) {
      try {
        await sendNotification({
          title: "Volo monitor needs attention",
          message: `The monitor failed: ${truncate(message, 280)}`,
          priority: "4",
          tags: "warning,soccer",
        });
        state.lastErrorDate = today;
      } catch (notificationError) {
        console.error(
          "Could not send the failure notification:",
          notificationError
        );
      }
    }

    state.keepaliveMonth = month;
    await writeState(state);
    process.exitCode = 1;
  }
}

await main();
