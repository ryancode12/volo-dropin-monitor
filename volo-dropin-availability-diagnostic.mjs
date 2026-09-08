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

function parseGraphqlPayload(postData) {
  if (!postData) return [];
  try {
    const parsed = JSON.parse(postData);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function shortValue(value) {
  const text = normalize(value);
  if (!text) return "";
  if (text === VOLO_EMAIL) return "[email]";
  if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(text)) return text.slice(0, 12) + "…";
  return text.length > 140 ? text.slice(0, 137) + "…" : text;
}

function summarizeVariables(variables) {
  if (!variables || typeof variables !== "object") return {};
  const output = {};
  for (const [key, value] of Object.entries(variables).slice(0, 30)) {
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

function collectTimedObjects(value, output = [], path = "data", depth = 0) {
  if (!value || depth > 11 || output.length >= 80) return output;
  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, 150); i += 1) {
      collectTimedObjects(value[i], output, `${path}[${i}]`, depth + 1);
    }
    return output;
  }
  if (typeof value !== "object") return output;

  const startRaw = value.start_time ?? value.startTime ?? value.start_at ?? value.startAt;
  const parsedStart = Date.parse(String(startRaw ?? ""));
  if (startRaw && Number.isFinite(parsedStart)) {
    const pick = (patterns) => {
      for (const [key, child] of Object.entries(value)) {
        if (!patterns.some((pattern) => pattern.test(key))) continue;
        if (typeof child === "string" || typeof child === "number") return shortValue(child);
        if (child && typeof child === "object") {
          const nested = child.name ?? child.title ?? child.label ?? child._id ?? child.id;
          if (nested != null) return shortValue(nested);
        }
      }
      return "";
    };

    output.push({
      path,
      start: new Date(parsedStart).toISOString(),
      end: shortValue(value.end_time ?? value.endTime ?? value.end_at ?? value.endAt),
      id: shortValue(value._id ?? value.id ?? value.game_id ?? value.gameId),
      sport: pick([/^sport$/i, /sport.*name/i]),
      venue: pick([/^venue$/i, /venue.*name/i, /^facility$/i, /facility.*name/i]),
      field: pick([/^field$/i, /field.*name/i]),
      title: pick([/^title$/i, /^name$/i, /program.*name/i, /league.*name/i, /game.*name/i]),
    });
  }

  for (const [key, child] of Object.entries(value).slice(0, 180)) {
    if (/email|password|token|phone|address/i.test(key)) continue;
    collectTimedObjects(child, output, `${path}.${key}`, depth + 1);
  }
  return output;
}

function collectAvailabilityScalars(value, output = [], path = "data", depth = 0) {
  if (value == null || depth > 12 || output.length >= 160) return output;
  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, 150); i += 1) {
      collectAvailabilityScalars(value[i], output, `${path}[${i}]`, depth + 1);
    }
    return output;
  }
  if (typeof value !== "object") return output;

  for (const [key, child] of Object.entries(value).slice(0, 200)) {
    if (/email|password|token|phone|address/i.test(key)) continue;
    const childPath = `${path}.${key}`;
    if (
      /spot|avail|capacity|gender|men|women|male|female|open|preference|registr|roster|remaining|count/i.test(key) &&
      (typeof child === "string" || typeof child === "number" || typeof child === "boolean")
    ) {
      output.push({ path: childPath, value: shortValue(child) });
    }
    collectAvailabilityScalars(child, output, childPath, depth + 1);
  }
  return output;
}

function collectArrayShapes(value, output = [], path = "data", depth = 0) {
  if (!value || depth > 10 || output.length >= 80) return output;
  if (Array.isArray(value)) {
    output.push({ path, length: value.length });
    for (const item of value.slice(0, 6)) {
      collectArrayShapes(item, output, `${path}[]`, depth + 1);
    }
    return output;
  }
  if (typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value).slice(0, 120)) {
    if (/email|password|token|phone|address/i.test(key)) continue;
    collectArrayShapes(child, output, `${path}.${key}`, depth + 1);
  }
  return output;
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

function isRelevantOperation(operationName, variables, response) {
  let responseText = "";
  try {
    responseText = JSON.stringify(response).slice(0, 250_000);
  } catch {
    responseText = "";
  }
  const text = `${operationName} ${Object.keys(variables || {}).join(" ")} ${responseText.slice(0, 20_000)}`;
  return /drop|daily|discover|game|program|sport|avail|spot|gender|roster|capacity/i.test(text);
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
      const task = (async () => {
        if (!/\/hapi\/v1\/graphql(?:\?|$)/i.test(response.url())) return;
        const payloads = parseGraphqlPayload(response.request().postData());
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
          if (!isRelevantOperation(operationName, payload.variables, responseItem)) continue;
          records.push({
            operationName,
            stage,
            variables: summarizeVariables(payload.variables),
            timedObjects: collectTimedObjects(responseItem),
            availability: collectAvailabilityScalars(responseItem),
            arrays: collectArrayShapes(responseItem)
              .filter((item) => /drop|daily|game|program|sport|avail|spot|gender|roster|data/i.test(item.path))
              .slice(0, 30),
          });
        }
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

    const gameLinks = await page.evaluate(() => {
      const links = [];
      const seen = new Set();
      for (const link of document.querySelectorAll('a[href*="/game/"]')) {
        try {
          const url = new URL(link.href, location.href);
          if (url.origin !== location.origin) continue;
          if (seen.has(url.pathname)) continue;
          seen.add(url.pathname);
          links.push(url.pathname);
        } catch {}
      }
      return links.slice(0, 12);
    });

    for (const path of gameLinks) {
      stage = `game:${path.split("/").pop()?.slice(0, 12)}`;
      await page.goto(`https://www.volosports.com${path}`, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
      }).catch(() => null);
      await page.waitForNetworkIdle({ idleTime: 750, timeout: 20_000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await Promise.allSettled([...pending]);

    const deduped = [];
    const seen = new Set();
    for (const record of records) {
      const key = `${record.operationName}|${record.stage}|${JSON.stringify(record.variables)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(record);
    }

    console.log("AVAIL_DIAG authenticated=true");
    console.log("AVAIL_DIAG gameLinksVisited=" + gameLinks.length);
    console.log("AVAIL_DIAG relevantResponses=" + deduped.length);
    deduped.forEach((record, index) => {
      console.log("AVAIL_DIAG record=" + (index + 1) + " " + JSON.stringify(record));
    });
  } finally {
    await browser.close();
  }
}

await main();
