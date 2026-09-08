import puppeteer from "puppeteer-core";

const LOGIN_URL = "https://www.volosports.com/login";
const DISCOVER_URL =
  "https://www.volosports.com/discover/denver?category=daily-sports&programType=dropin&sports=soccer";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const TIMEZONE = "America/Denver";
const VOLO_EMAIL = requiredEnv("VOLO_EMAIL");
const VOLO_PASSWORD = requiredEnv("VOLO_PASSWORD");

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function firstExistingSelector(page, selectors) {
  for (const selector of selectors) {
    if (await page.$(selector)) return selector;
  }
  return null;
}

async function configurePage(page) {
  await page.emulateTimezone(TIMEZONE);
  await page.setViewport({ width: 1440, height: 1400, deviceScaleFactor: 1 });
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
  );
}

async function submitLogin(page) {
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
    throw new Error("Could not find Volo login fields.");
  }

  await page.click(emailSelector, { clickCount: 3 });
  await page.type(emailSelector, VOLO_EMAIL, { delay: 10 });
  await page.click(passwordSelector, { clickCount: 3 });
  await page.type(passwordSelector, VOLO_PASSWORD, { delay: 10 });

  const navigation = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 120_000 })
    .catch(() => null);

  const clicked = await page.evaluate(() => {
    const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const controls = [
      ...document.querySelectorAll('button, input[type="submit"], [role="button"]'),
    ];
    const target = controls.find((element) =>
      /^(?:log in with email|log in|sign in)$/i.test(
        clean(element.innerText || element.value || element.textContent)
      )
    );
    if (!target) return false;
    target.click();
    return true;
  });

  if (!clicked) await page.press(passwordSelector, "Enter");
  await navigation;
  await page.waitForNetworkIdle({ idleTime: 750, timeout: 25_000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  if (/\/login(?:\/|$|\?)/i.test(page.url())) {
    throw new Error("Volo login did not leave the login page.");
  }
}

async function discoverCards(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 30_000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 4_000));

  return page.evaluate(() => {
    const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const cards = [];
    const seen = new Set();
    for (const link of document.querySelectorAll('a[href*="/game/"]')) {
      let url;
      try {
        url = new URL(link.href, location.href);
      } catch {
        continue;
      }
      if (seen.has(url.pathname)) continue;
      seen.add(url.pathname);

      let node = link;
      let text = clean(link.innerText || link.textContent);
      for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
        const candidate = clean(node.innerText || node.textContent);
        if (/\bsoccer\b/i.test(candidate) && /\bdrop[ -]?in\b/i.test(candidate)) {
          text = candidate;
          break;
        }
      }
      cards.push({ path: url.pathname, text: text.slice(0, 700) });
    }
    return cards.slice(0, 20);
  });
}

function gameIdFromPath(path) {
  return String(path || "").split("/").filter(Boolean).pop() || "";
}

async function routeSnapshot(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 }).catch(() => null);
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 20_000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  return page.evaluate(() => {
    const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const raw = document.body?.innerText || "";
    const lines = raw
      .split(/\n+/)
      .map(clean)
      .filter(Boolean);

    const interesting = /spot|women|woman|female|men|male|any gender|open gender|no preference|choose spot|available|availability|register|registration|drop[ -]?in|sold out|full|waitlist|join/i;
    const snippets = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!interesting.test(lines[index])) continue;
      const start = Math.max(0, index - 2);
      const end = Math.min(lines.length, index + 3);
      const snippet = lines.slice(start, end).join(" | ");
      if (!snippets.includes(snippet)) snippets.push(snippet);
      if (snippets.length >= 16) break;
    }

    const controls = [
      ...document.querySelectorAll('button, [role="button"], a, input, select, option'),
    ]
      .map((element) =>
        clean(
          element.innerText ||
            element.textContent ||
            element.value ||
            element.getAttribute("aria-label") ||
            element.getAttribute("placeholder") ||
            ""
        )
      )
      .filter((text) => text && interesting.test(text));

    return {
      finalUrl: location.href,
      title: document.title,
      snippets: [...new Set(snippets)].slice(0, 16),
      controls: [...new Set(controls)].slice(0, 25),
      bodyPrefix: clean(raw).slice(0, 900),
    };
  });
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    timeout: 120_000,
    protocolTimeout: 300_000,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    await configurePage(page);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForNetworkIdle({ idleTime: 750, timeout: 25_000 }).catch(() => {});
    await submitLogin(page);

    const baseCards = await discoverCards(page, DISCOVER_URL);
    const menCards = await discoverCards(page, DISCOVER_URL + "&minimumMen=1");
    const union = [];
    const seen = new Set();
    for (const card of [...baseCards, ...menCards]) {
      if (seen.has(card.path)) continue;
      seen.add(card.path);
      union.push(card);
    }

    console.log("APPROUTE authenticated=true");
    console.log("APPROUTE cards=" + JSON.stringify(union));

    for (const card of union.slice(0, 10)) {
      const gameId = gameIdFromPath(card.path);
      if (!gameId) continue;
      const publicRoute = await routeSnapshot(page, `https://www.volosports.com/game/${encodeURIComponent(gameId)}`);
      const appRoute = await routeSnapshot(page, `https://www.volosports.com/app/${encodeURIComponent(gameId)}`);
      console.log(
        "APPROUTE game=" +
          JSON.stringify({
            gameId,
            cardText: card.text,
            gameRoute: publicRoute,
            appRoute,
          })
      );
    }
  } finally {
    await browser.close();
  }
}

await main();
