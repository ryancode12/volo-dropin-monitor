import puppeteer from "puppeteer-core";

const LOGIN_URL = "https://www.volosports.com/login";
const DASHBOARD_FALLBACK_URL = "https://www.volosports.com/dashboard";
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

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function notify(title, message, priority = "3", tags = "calendar,white_check_mark") {
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
      headers: {
        Authorization: `Bearer ${GOOGLE_ACCESS_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `Google Calendar access failed with HTTP ${response.status}: ${normalizeText(
        await response.text()
      ).slice(0, 300)}`
    );
  }

  const calendar = await response.json();
  return normalizeText(calendar.summary) || "Volo";
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
    const controls = [
      ...document.querySelectorAll('button, input[type="submit"], [role="button"]'),
    ];
    const control = controls.find((element) =>
      /^(?:log in with email|log in|sign in)$/i.test(
        String(element.innerText || element.value || element.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
      )
    );
    if (!control) return false;
    control.click();
    return true;
  });

  if (!clicked) await page.press(passwordSelector, "Enter");
  await navigation;
  await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

async function loginAndInspectDashboard() {
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

  try {
    const page = await browser.newPage();
    await configurePage(page);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => {});
    await submitLogin(page);

    const loginStatus = await page.evaluate(() => ({
      url: location.href,
      body: String(document.body?.innerText ?? "").replace(/\s+/g, " ").trim(),
      dashboardLinks: [...document.querySelectorAll("a[href]")]
        .map((link) => ({
          href: link.href,
          text: String(link.innerText || link.textContent || "")
            .replace(/\s+/g, " ")
            .trim(),
        }))
        .filter(
          (link) =>
            /dashboard|schedule|upcoming/i.test(link.text) ||
            /dashboard|schedule/i.test(link.href)
        ),
    }));

    if (
      /\/login(?:\/|$|\?)/i.test(loginStatus.url) ||
      /incorrect|invalid|unable to log in|wrong password/i.test(loginStatus.body)
    ) {
      throw new Error("Volo did not accept the stored email/password login.");
    }

    const dashboardLink = loginStatus.dashboardLinks.find(
      (link) => !/logout|login/i.test(link.href)
    );

    if (dashboardLink && dashboardLink.href !== page.url()) {
      await page.goto(dashboardLink.href, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    } else if (!/dashboard|schedule/i.test(page.url())) {
      const response = await page
        .goto(DASHBOARD_FALLBACK_URL, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        })
        .catch(() => null);
      if (response) {
        await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    }

    const result = await page.evaluate(() => {
      const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
      const links = [...document.querySelectorAll('a[href*="/game/"]')];
      const seen = new Set();
      const games = [];

      for (const link of links) {
        const url = link.href;
        if (!url || seen.has(url)) continue;
        seen.add(url);

        let container = link;
        for (let depth = 0; depth < 6; depth += 1) {
          const parent = container.parentElement;
          if (!parent) break;
          const parentText = normalize(parent.innerText || parent.textContent);
          if (parentText.length > 2_500) break;
          container = parent;
          if (
            /\b(?:am|pm)\b/i.test(parentText) &&
            /\b(?:soccer|pickleball|pickup|drop-?in)\b/i.test(parentText)
          ) {
            break;
          }
        }

        games.push({
          url,
          text: normalize(container.innerText || container.textContent).slice(0, 500),
        });
      }

      return {
        finalUrl: location.href,
        title: document.title,
        games,
        bodyPreview: normalize(document.body?.innerText).slice(0, 1_500),
      };
    });

    if (/\/login(?:\/|$|\?)/i.test(result.finalUrl)) {
      throw new Error("The dashboard redirected back to the Volo login page.");
    }

    return result;
  } finally {
    await browser.close();
  }
}

async function main() {
  try {
    const [calendarName, dashboard] = await Promise.all([
      verifyCalendarAccess(),
      loginAndInspectDashboard(),
    ]);

    const examples = dashboard.games
      .slice(0, 3)
      .map((game, index) => `${index + 1}. ${game.text || game.url}`)
      .join("\n");

    const message = [
      `Google calendar access: OK (${calendarName}).`,
      `Volo login: OK.`,
      `Registered game links detected: ${dashboard.games.length}.`,
      examples ? `Examples:\n${examples}` : `Dashboard URL checked: ${dashboard.finalUrl}`,
    ].join("\n");

    console.log(
      JSON.stringify(
        {
          calendarName,
          dashboardUrl: dashboard.finalUrl,
          pageTitle: dashboard.title,
          registeredGameLinks: dashboard.games,
          bodyPreview: dashboard.bodyPreview,
        },
        null,
        2
      )
    );

    await notify("Volo calendar diagnostic passed", message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    await notify(
      "Volo calendar diagnostic failed",
      normalizeText(message).slice(0, 600),
      "4",
      "calendar,warning"
    ).catch((notificationError) => {
      console.error("Could not send diagnostic failure notification:", notificationError);
    });
    process.exitCode = 1;
  }
}

await main();
