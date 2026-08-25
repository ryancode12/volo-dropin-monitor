import puppeteer from "puppeteer-core";

const LOGIN_URL = "https://www.volosports.com/login";
const DASHBOARD_URL = "https://www.volosports.com/app/dashboard";
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
  await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 25_000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  if (/\/login(?:\/|$|\?)/i.test(page.url())) {
    throw new Error("Volo login did not leave the login page.");
  }
}

function findCurrentUserId(value, depth = 0) {
  if (!value || depth > 8) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCurrentUserId(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  if (value.currentUser && typeof value.currentUser === "object") {
    const id = value.currentUser._id ?? value.currentUser.id;
    if (id) return normalize(id);
  }
  for (const child of Object.values(value)) {
    const found = findCurrentUserId(child, depth + 1);
    if (found) return found;
  }
  return "";
}

function shortValue(value) {
  const text = normalize(value);
  if (!text) return "";
  if (text === VOLO_EMAIL) return "[email]";
  if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(text)) return text.slice(0, 12) + "…";
  return text.length > 120 ? text.slice(0, 117) + "…" : text;
}

function summarizeVariables(variables, currentUserId) {
  if (!variables || typeof variables !== "object") return {};
  const output = {};
  for (const [key, value] of Object.entries(variables).slice(0, 20)) {
    if (/user/i.test(key) && normalize(value) === currentUserId) {
      output[key] = "[current-user]";
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = shortValue(value);
    } else if (value && typeof value === "object") {
      output[key] = "[object]";
    }
  }
  return output;
}

function selectedText(object, patterns) {
  if (!object || typeof object !== "object") return "";
  for (const [key, value] of Object.entries(object)) {
    if (!patterns.some((pattern) => pattern.test(key))) continue;
    if (typeof value === "string" || typeof value === "number") return shortValue(value);
  }
  return "";
}

function collectTimedObjects(value, output = [], path = "data", depth = 0) {
  if (!value || depth > 10 || output.length >= 30) return output;
  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 100); index += 1) {
      collectTimedObjects(value[index], output, `${path}[${index}]`, depth + 1);
    }
    return output;
  }
  if (typeof value !== "object") return output;

  const startRaw = value.start_time ?? value.startTime ?? value.start_at ?? value.startAt;
  const startTimestamp = Date.parse(String(startRaw ?? ""));
  if (startRaw && Number.isFinite(startTimestamp)) {
    output.push({
      path,
      start: new Date(startTimestamp).toISOString(),
      end: shortValue(value.end_time ?? value.endTime ?? value.end_at ?? value.endAt),
      id: shortValue(value._id ?? value.id ?? value.game_id ?? value.gameId),
      sport: selectedText(value, [/^sport$/i, /sport.*name/i]),
      venue: selectedText(value, [/venue.*name/i, /facility.*name/i, /^venue$/i]),
      field: selectedText(value, [/field.*name/i, /^field$/i]),
      title: selectedText(value, [/program.*name/i, /league.*name/i, /game.*name/i, /^title$/i]),
    });
  }

  for (const [key, child] of Object.entries(value).slice(0, 150)) {
    if (/email|password|token|phone|address/i.test(key)) continue;
    collectTimedObjects(child, output, `${path}.${key}`, depth + 1);
  }
  return output;
}

function collectArrayShapes(value, output = [], path = "data", depth = 0) {
  if (!value || depth > 9 || output.length >= 20) return output;
  if (Array.isArray(value)) {
    output.push({ path, length: value.length });
    for (const item of value.slice(0, 5)) collectArrayShapes(item, output, path + "[]", depth + 1);
    return output;
  }
  if (typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    collectArrayShapes(child, output, `${path}.${key}`, depth + 1);
  }
  return output;
}

async function collectSafeLinks(page) {
  return await page.evaluate(() => {
    const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const wanted = /soccer|drop[\s-]*in|pickup|daily sports|game|schedule|reservation|registration/i;
    const dangerous = /cancel|withdraw|delete|remove|refund|register now|sign up|purchase|checkout/i;
    const output = [];
    const seen = new Set();

    for (const link of document.querySelectorAll("a[href]")) {
      let url;
      try {
        url = new URL(link.href, location.href);
      } catch {
        continue;
      }
      if (url.origin !== location.origin) continue;

      let text = clean(link.innerText || link.textContent);
      if (!wanted.test(text)) {
        let ancestor = link.parentElement;
        for (let depth = 0; ancestor && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
          const candidate = clean(ancestor.innerText || ancestor.textContent);
          if (candidate.length <= 900 && wanted.test(candidate)) {
            text = candidate;
            break;
          }
        }
      }
      const combined = text + " " + url.pathname;
      if (!wanted.test(combined) || dangerous.test(combined)) continue;
      const path = url.pathname + url.search;
      if (seen.has(path)) continue;
      seen.add(path);
      output.push({ path, label: text.slice(0, 160) });
    }

    return output.slice(0, 40);
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

  const rawRecords = [];
  const pending = new Set();
  let currentUserId = "";
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
          const operationName = normalize(payload.operationName);
          const responseItem = responseItems[index] ?? responseItems[0];

          if (/^(?:GetLoggedInUser|CurrentUser)$/i.test(operationName)) {
            currentUserId ||= findCurrentUserId(responseItem);
          }

          if (/^(?:myDropInRsvps|getDropInRSVPs|getDropInData|getDropInInfo)$/i.test(operationName)) {
            rawRecords.push({
              operationName,
              stage,
              variables: payload.variables || {},
              response: responseItem,
            });
          }
        }
      })()
        .catch(() => {})
        .finally(() => pending.delete(task));
      pending.add(task);
    });

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 25_000 }).catch(() => {});
    await submitLogin(page);

    stage = "dashboard";
    if (!/\/app\/dashboard(?:\/|$|\?)/i.test(page.url())) {
      await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
    }
    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 25_000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    const links = await collectSafeLinks(page);
    for (const link of links) {
      stage = "route:" + link.path.slice(0, 100);
      await page
        .goto(new URL(link.path, "https://www.volosports.com").toString(), {
          waitUntil: "domcontentloaded",
          timeout: 120_000,
        })
        .catch(() => null);
      await page.waitForNetworkIdle({ idleTime: 750, timeout: 20_000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1_250));
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await Promise.allSettled([...pending]);

    const records = rawRecords.map((record) => {
      let serialized = "";
      try {
        serialized = JSON.stringify(record.response);
      } catch {
        serialized = "";
      }
      return {
        operationName: record.operationName,
        stage: record.stage,
        variables: summarizeVariables(record.variables, currentUserId),
        containsCurrentUser: Boolean(currentUserId && serialized.includes(currentUserId)),
        timedObjects: collectTimedObjects(record.response),
        arrays: collectArrayShapes(record.response)
          .filter((item) => /rsvp|registr|game|drop|data/i.test(item.path))
          .slice(0, 12),
      };
    });

    console.log("DROPIN_DIAG currentUserDetected=" + Boolean(currentUserId));
    console.log("DROPIN_DIAG safeLinksVisited=" + links.length);
    console.log("DROPIN_DIAG relevantResponses=" + records.length);
    records.forEach((record, index) => {
      console.log(
        "DROPIN_DIAG record=" +
          (index + 1) +
          " " +
          JSON.stringify(record)
      );
    });
  } finally {
    await browser.close();
  }
}

await main();
