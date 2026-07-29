import puppeteer from "puppeteer-core";

const LOGIN_URL = "https://www.volosports.com/login";
const DASHBOARD_URL = "https://www.volosports.com/app/dashboard";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const TIMEZONE = "America/Denver";

const VOLO_EMAIL = requiredEnv("VOLO_EMAIL");
const VOLO_PASSWORD = requiredEnv("VOLO_PASSWORD");
const GOOGLE_ACCESS_TOKEN = requiredEnv("GOOGLE_ACCESS_TOKEN");
const GOOGLE_CALENDAR_ID = requiredEnv("GOOGLE_CALENDAR_ID");
const NTFY_TOPIC = requiredEnv("NTFY_TOPIC");

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sanitize(value) {
  return normalize(value)
    .replaceAll(VOLO_EMAIL, "[email]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .slice(0, 4_000);
}

async function notify(title, message, priority = "3", tags = "calendar,magnifying_glass_tilted_left") {
  const response = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Title: title,
      Priority: priority,
      Tags: tags,
    },
    body: message,
  });

  if (!response.ok) {
    throw new Error(`ntfy returned HTTP ${response.status}: ${await response.text()}`);
  }
}

async function verifyCalendarAccess() {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}`,
    {
      headers: { Authorization: `Bearer ${GOOGLE_ACCESS_TOKEN}` },
    }
  );

  if (!response.ok) {
    throw new Error(`Google Calendar access failed with HTTP ${response.status}`);
  }

  const calendar = await response.json();
  return normalize(calendar.summary) || "Volo";
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
  await page.type(emailSelector, VOLO_EMAIL, { delay: 15 });
  await page.click(passwordSelector, { clickCount: 3 });
  await page.type(passwordSelector, VOLO_PASSWORD, { delay: 15 });

  const navigation = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 })
    .catch(() => null);

  const clicked = await page.evaluate(() => {
    const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const controls = [
      ...document.querySelectorAll('button, input[type="submit"], [role="button"]'),
    ];
    const target = controls.find((element) =>
      /^(?:log in with email|log in|sign in)$/i.test(
        normalizeText(element.innerText || element.value || element.textContent)
      )
    );
    if (!target) return false;
    target.click();
    return true;
  });

  if (!clicked) await page.press(passwordSelector, "Enter");
  await navigation;
  await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  const status = await page.evaluate(() => ({
    url: location.href,
    body: String(document.body?.innerText ?? "").replace(/\s+/g, " ").trim(),
  }));

  if (
    /\/login(?:\/|$|\?)/i.test(status.url) ||
    /incorrect|invalid|unable to log in|wrong password/i.test(status.body)
  ) {
    throw new Error("Volo did not accept the stored email/password login.");
  }
}

function collectSchema(value, output, path = "data", depth = 0) {
  if (depth > 10 || value == null) return;

  if (Array.isArray(value)) {
    const identity = `${path}[]|Array`;
    if (!output.some((item) => item.identity === identity)) {
      output.push({ identity, path: `${path}[]`, typename: "Array", keys: [], length: value.length });
    }
    for (const item of value.slice(0, 15)) {
      collectSchema(item, output, `${path}[]`, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") return;

  const keys = Object.keys(value).slice(0, 40);
  const typename = typeof value.__typename === "string" ? normalize(value.__typename) : "Object";
  const identity = `${path}|${typename}|${keys.join(",")}`;
  if (!output.some((item) => item.identity === identity)) {
    output.push({ identity, path, typename, keys });
  }

  for (const key of Object.keys(value).slice(0, 100)) {
    collectSchema(value[key], output, `${path}.${key}`, depth + 1);
  }
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

function operationKey(operationName, variableKeys, stage) {
  return `${operationName}|${variableKeys.join(",")}|${stage}`;
}

async function collectNavigationControls(page) {
  return await page.evaluate(() => {
    const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const pattern = /upcoming|schedule|calendar|my games|games|events|activities|daily sports|pickup|drop-?in|reservation|registration/i;
    const dangerous = /cancel|withdraw|delete|remove|refund|register now|sign up|purchase|checkout/i;
    const controls = [
      ...document.querySelectorAll('a[href], button, [role="button"], [role="tab"]'),
    ];

    const results = [];
    const seen = new Set();
    for (const element of controls) {
      const text = normalizeText(
        element.innerText ||
          element.getAttribute("aria-label") ||
          element.textContent ||
          element.value
      );
      const href = element.href || "";
      let path = "";
      try {
        const url = new URL(href, location.href);
        if (url.origin === location.origin) path = url.pathname;
      } catch {
        path = "";
      }

      const combined = `${text} ${path}`;
      if (!pattern.test(combined) || dangerous.test(combined)) continue;
      const identity = `${text}|${path}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      results.push({ text: text.slice(0, 100), path });
    }

    return results.slice(0, 40);
  });
}

async function clickSafeNavigationControl(page, label) {
  return await page.evaluate((targetLabel) => {
    const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const dangerous = /cancel|withdraw|delete|remove|refund|register now|sign up|purchase|checkout/i;
    const controls = [
      ...document.querySelectorAll('button, [role="button"], [role="tab"], a[href]'),
    ];
    const target = controls.find((element) => {
      const text = normalizeText(
        element.innerText ||
          element.getAttribute("aria-label") ||
          element.textContent ||
          element.value
      );
      return text === targetLabel && !dangerous.test(text);
    });
    if (!target) return false;
    target.click();
    return true;
  }, label);
}

async function inspectVolo() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const operations = [];
  const controls = [];
  const pending = new Set();
  let stage = "login";

  try {
    const page = await browser.newPage();
    await configurePage(page);

    page.on("response", (response) => {
      const task = (async () => {
        const url = response.url();
        if (!/\/hapi\/v1\/graphql(?:\?|$)/i.test(url)) return;

        const payloads = parseGraphqlPayload(response.request().postData());
        if (payloads.length === 0) return;

        let responseJson;
        try {
          responseJson = await response.json();
        } catch {
          responseJson = null;
        }
        const responseItems = Array.isArray(responseJson) ? responseJson : [responseJson];

        for (let index = 0; index < payloads.length; index += 1) {
          const payload = payloads[index] || {};
          const operationName = normalize(payload.operationName) || "unnamed";
          const variableKeys =
            payload.variables && typeof payload.variables === "object"
              ? Object.keys(payload.variables).sort().slice(0, 30)
              : [];
          const schema = [];
          collectSchema(responseItems[index] ?? responseItems[0], schema);

          const key = operationKey(operationName, variableKeys, stage);
          if (!operations.some((item) => item.key === key)) {
            operations.push({
              key,
              operationName,
              variableKeys,
              stage,
              schema: schema.slice(0, 150),
            });
          }
        }
      })()
        .catch(() => {})
        .finally(() => pending.delete(task));
      pending.add(task);
    });

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => {});
    await submitLogin(page);

    stage = "dashboard";
    if (!/\/app\/dashboard(?:\/|$|\?)/i.test(page.url())) {
      await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 25_000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    const initialControls = await collectNavigationControls(page);
    controls.push(...initialControls.map((item) => ({ stage: "dashboard", ...item })));

    const safeLabels = [...new Set(initialControls.map((item) => item.text).filter(Boolean))].slice(0, 10);
    for (const label of safeLabels) {
      stage = `clicked:${label.slice(0, 40)}`;
      await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForNetworkIdle({ idleTime: 750, timeout: 15_000 }).catch(() => {});
      const clicked = await clickSafeNavigationControl(page, label);
      if (!clicked) continue;
      await page.waitForNetworkIdle({ idleTime: 750, timeout: 15_000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const found = await collectNavigationControls(page);
      controls.push(...found.map((item) => ({ stage, ...item })));
    }

    const paths = [
      ...new Set(
        controls
          .map((item) => item.path)
          .filter((path) => path && path.startsWith("/app/") && path !== "/app/dashboard")
      ),
    ].slice(0, 10);

    for (const path of paths) {
      stage = `route:${path}`;
      await page
        .goto(`https://www.volosports.com${path}`, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        })
        .catch(() => null);
      await page.waitForNetworkIdle({ idleTime: 750, timeout: 15_000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const found = await collectNavigationControls(page).catch(() => []);
      controls.push(...found.map((item) => ({ stage, ...item })));
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await Promise.allSettled([...pending]);

    const storageKeys = await page.evaluate(() => ({
      localStorage: Object.keys(localStorage).sort().slice(0, 50),
      sessionStorage: Object.keys(sessionStorage).sort().slice(0, 50),
    }));

    return { operations, controls, storageKeys };
  } finally {
    await browser.close();
  }
}

function isRelevantOperation(item) {
  const text = `${item.operationName} ${item.variableKeys.join(" ")} ${item.stage}`;
  return /user|schedule|calendar|game|event|activity|pickup|drop|daily|registr|reservation|rental|order|booking/i.test(
    text
  );
}

function relevantSchemaLines(operation) {
  const keyword = /user|schedule|calendar|game|event|activity|pickup|drop|daily|registr|reservation|rental|order|booking|program|league|team|start|date|venue|location/i;
  return operation.schema
    .filter((item) => keyword.test(`${item.path} ${item.typename} ${item.keys.join(" ")}`))
    .slice(0, 5)
    .map(
      (item) =>
        `${item.path} [${item.typename}] keys: ${item.keys.join(", ") || `(array length ${item.length ?? 0})`}`
    );
}

async function main() {
  try {
    const [calendarName, diagnostic] = await Promise.all([
      verifyCalendarAccess(),
      inspectVolo(),
    ]);

    const operationNames = [...new Set(diagnostic.operations.map((item) => item.operationName))];
    const relevant = diagnostic.operations.filter(isRelevantOperation);
    const schemaExamples = relevant
      .flatMap((operation) =>
        relevantSchemaLines(operation).map(
          (line) => `${operation.operationName} @ ${operation.stage}\n${line}`
        )
      )
      .slice(0, 8);

    const controlExamples = [...new Map(
      diagnostic.controls.map((item) => [`${item.text}|${item.path}`, item])
    ).values()]
      .slice(0, 10)
      .map((item) => `${item.text || "(no label)"}${item.path ? ` -> ${item.path}` : ""}`);

    const message = [
      `Google calendar access: OK (${calendarName}).`,
      "Volo login: OK.",
      `All GraphQL operations observed: ${operationNames.length}.`,
      `Operations: ${operationNames.join(", ") || "none"}.`,
      `Relevant operation-stage records: ${relevant.length}.`,
      controlExamples.length
        ? `Schedule-related controls:\n${controlExamples.join("\n")}`
        : "Schedule-related controls: none detected.",
      schemaExamples.length
        ? `Relevant schema examples:\n${schemaExamples.join("\n\n")}`
        : "Relevant schema examples: none detected.",
    ].join("\n");

    console.log(
      JSON.stringify(
        {
          calendarName,
          operationNames,
          operations: diagnostic.operations.map((item) => ({
            operationName: item.operationName,
            variableKeys: item.variableKeys,
            stage: item.stage,
            schema: item.schema,
          })),
          controls: diagnostic.controls,
          storageKeys: diagnostic.storageKeys,
        },
        null,
        2
      )
    );

    await notify("Volo complete GraphQL diagnostic", sanitize(message));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    await notify(
      "Volo GraphQL diagnostic failed",
      sanitize(message).slice(0, 700),
      "4",
      "calendar,warning"
    ).catch((notificationError) => {
      console.error("Could not send diagnostic failure notification:", notificationError);
    });
    process.exitCode = 1;
  }
}

await main();
