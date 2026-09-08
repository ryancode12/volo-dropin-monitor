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

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function shortValue(value) {
  const text = normalize(value);
  if (!text) return "";
  if (text === VOLO_EMAIL) return "[email]";
  if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(text)) return text.slice(0, 12) + "…";
  return text.length > 120 ? text.slice(0, 117) + "…" : text;
}

function parseGraphqlPayload(postData) {
  if (!postData) return [];
  try {
    const parsed = JSON.parse(postData);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function summarizeVariables(variables) {
  if (!variables || typeof variables !== "object") return {};
  const output = {};
  for (const [key, value] of Object.entries(variables).slice(0, 40)) {
    if (/email|password|token|phone|address/i.test(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = shortValue(value);
    } else if (Array.isArray(value)) {
      output[key] = `[array:${value.length}]`;
    } else if (value && typeof value === "object") {
      output[key] = "[object]";
    }
  }
  return output;
}

function normalizedPath(path) {
  return path.replace(/\[\d+\]/g, "[]");
}

function isSensitivePath(path) {
  if (/email|password|token|phone|address|birth|first.?name|last.?name|username/i.test(path)) {
    return true;
  }
  if (/\.user\./i.test(path) && !/\.user\.gender$/i.test(path)) return true;
  return false;
}

function summarizeStructure(value) {
  const scalarMap = new Map();
  const arrayMap = new Map();
  const timedMap = new Map();
  let visited = 0;

  const relevantPath = (path) =>
    /slot|drop.?in|spot|avail|capacity|gender|men|women|male|female|open|preference|registr|roster|remaining|count|game|team|league/i.test(
      path
    );

  const addScalar = (path, raw) => {
    if (!relevantPath(path) || isSensitivePath(path)) return;
    const key = normalizedPath(path);
    const values = scalarMap.get(key) || new Set();
    if (values.size < 6) values.add(shortValue(raw));
    scalarMap.set(key, values);
  };

  const addArray = (path, length) => {
    if (!relevantPath(path)) return;
    const key = normalizedPath(path);
    const previous = arrayMap.get(key);
    if (previous == null || length > previous) arrayMap.set(key, length);
  };

  const walk = (node, path = "data", depth = 0) => {
    if (node == null || depth > 13 || visited > 50_000) return;
    visited += 1;

    if (Array.isArray(node)) {
      addArray(path, node.length);
      for (let index = 0; index < Math.min(node.length, 200); index += 1) {
        walk(node[index], `${path}[${index}]`, depth + 1);
      }
      return;
    }

    if (typeof node !== "object") return;

    const startRaw = node.start_time ?? node.startTime ?? node.start_at ?? node.startAt;
    const startTimestamp = Date.parse(String(startRaw ?? ""));
    if (startRaw && Number.isFinite(startTimestamp)) {
      const pathKey = normalizedPath(path);
      if (!timedMap.has(pathKey)) {
        timedMap.set(pathKey, {
          path: pathKey,
          start: new Date(startTimestamp).toISOString(),
          end: shortValue(node.end_time ?? node.endTime ?? node.end_at ?? node.endAt),
          id: shortValue(node._id ?? node.id ?? node.game_id ?? node.gameId),
        });
      }
    }

    for (const [key, child] of Object.entries(node).slice(0, 250)) {
      const childPath = `${path}.${key}`;
      if (isSensitivePath(childPath)) continue;
      if (child == null) continue;
      if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
        addScalar(childPath, child);
      } else {
        walk(child, childPath, depth + 1);
      }
    }
  };

  walk(value);

  const scalars = [...scalarMap.entries()]
    .map(([path, values]) => ({ path, values: [...values] }))
    .slice(0, 120);
  const arrays = [...arrayMap.entries()]
    .map(([path, length]) => ({ path, length }))
    .slice(0, 60);
  const timedObjects = [...timedMap.values()].slice(0, 30);

  return { scalars, arrays, timedObjects };
}

function looksRelevantSummary(summary, operationName = "", endpoint = "") {
  const text = [
    operationName,
    endpoint,
    ...summary.scalars.map((item) => item.path),
    ...summary.arrays.map((item) => item.path),
    ...summary.timedObjects.map((item) => item.path),
  ].join(" ");
  return /slot|drop.?in|spot|avail|capacity|gender|registr|roster|game|team|league|daily|discover|sport/i.test(
    text
  );
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
    throw new Error("Could not find the Volo email or password field.");
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

function endpointLabel(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.pathname + (url.search ? "?" + [...url.searchParams.keys()].join("&") : "");
  } catch {
    return shortValue(rawUrl);
  }
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    timeout: 120_000,
    protocolTimeout: 300_000,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const records = [];
  const pending = new Set();
  let stage = "login";

  try {
    const page = await browser.newPage();
    await configurePage(page);

    page.on("response", (response) => {
      const responseStage = stage;
      const task = (async () => {
        const request = response.request();
        const rawUrl = response.url();
        const endpoint = endpointLabel(rawUrl);
        const isGraphql = /\/hapi\/v1\/graphql(?:\?|$)/i.test(rawUrl);

        if (isGraphql) {
          const payloads = parseGraphqlPayload(request.postData());
          if (payloads.length === 0) return;
          let json;
          try {
            json = await response.json();
          } catch {
            return;
          }
          const responseItems = Array.isArray(json) ? json : [json];
          for (let index = 0; index < payloads.length; index += 1) {
            const payload = payloads[index] || {};
            const operationName = normalize(payload.operationName) || "unnamed";
            const responseItem = responseItems[index] ?? responseItems[0];
            const summary = summarizeStructure(responseItem);
            if (!looksRelevantSummary(summary, operationName, endpoint)) continue;
            records.push({
              kind: "graphql",
              stage: responseStage,
              operationName,
              endpoint,
              variables: summarizeVariables(payload.variables),
              ...summary,
            });
          }
          return;
        }

        if (!["xhr", "fetch"].includes(request.resourceType())) return;
        const contentType = normalize(response.headers()["content-type"] || "");
        if (!/json/i.test(contentType)) return;

        let json;
        try {
          json = await response.json();
        } catch {
          return;
        }
        const summary = summarizeStructure(json);
        if (!looksRelevantSummary(summary, "", endpoint)) return;
        records.push({
          kind: "json",
          stage: responseStage,
          operationName: "",
          endpoint,
          method: request.method(),
          ...summary,
        });
      })()
        .catch(() => {})
        .finally(() => pending.delete(task));
      pending.add(task);
    });

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForNetworkIdle({ idleTime: 750, timeout: 25_000 }).catch(() => {});
    await submitLogin(page);

    stage = "discover";
    await page.goto(DISCOVER_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 30_000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const discoverSnapshot = await page.evaluate(() => {
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
        for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
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

    const gameLinks = discoverSnapshot.map((item) => item.path).slice(0, 12);

    for (const path of gameLinks) {
      stage = `game:${path.split("/").pop()?.slice(0, 12)}`;
      await page
        .goto(`https://www.volosports.com${path}`, {
          waitUntil: "domcontentloaded",
          timeout: 120_000,
        })
        .catch(() => null);
      await page.waitForNetworkIdle({ idleTime: 750, timeout: 20_000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1_750));
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await Promise.allSettled([...pending]);

    const deduped = [];
    const seen = new Set();
    for (const record of records) {
      const key = [
        record.kind,
        record.stage,
        record.operationName,
        record.endpoint,
        JSON.stringify(record.variables || {}),
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(record);
    }

    console.log("AVAIL2 authenticated=true");
    console.log("AVAIL2 discoverCards=" + JSON.stringify(discoverSnapshot));
    console.log("AVAIL2 gameLinksVisited=" + gameLinks.length);
    console.log("AVAIL2 relevantResponses=" + deduped.length);
    deduped.slice(0, 180).forEach((record, index) => {
      console.log("AVAIL2 record=" + (index + 1) + " " + JSON.stringify(record));
    });
  } finally {
    await browser.close();
  }
}

await main();
