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

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function safeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(rawUrl ?? "").slice(0, 250);
  }
}

function sanitize(value) {
  return normalizeText(value)
    .replaceAll(VOLO_EMAIL, "[email]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:access|refresh|id)[_-]?token\b\s*[:=]\s*["']?[^"',\s}]+/gi, "$&[redacted]");
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
      `Google Calendar access failed with HTTP ${response.status}: ${sanitize(
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

function extractJsonEventCandidates(value, sourceUrl, output, depth = 0) {
  if (depth > 8 || value == null) return;

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) {
      extractJsonEventCandidates(item, sourceUrl, output, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") return;

  const keys = Object.keys(value);
  const compact = JSON.stringify(value);
  const hasSport = /\b(?:soccer|pickleball)\b/i.test(compact);
  const hasEventSignal =
    /\b(?:game|pickup|drop.?in|registration|program|schedule|start.?time|start.?date|venue)\b/i.test(
      compact
    );

  if (hasSport && hasEventSignal) {
    const first = (...names) => {
      for (const name of names) {
        const candidate = value[name];
        if (
          candidate !== undefined &&
          candidate !== null &&
          ["string", "number"].includes(typeof candidate)
        ) {
          return normalizeText(candidate);
        }
      }
      return "";
    };

    const candidate = {
      source: safeUrl(sourceUrl),
      id: first("gameId", "game_id", "registrationId", "registration_id", "id", "_id", "uuid"),
      title: first(
        "gameName",
        "game_name",
        "programName",
        "program_name",
        "name",
        "title",
        "sportName",
        "sport_name"
      ),
      start: first(
        "startDateTime",
        "start_datetime",
        "startsAt",
        "starts_at",
        "startTime",
        "start_time",
        "date",
        "startDate",
        "start_date"
      ),
      end: first("endDateTime", "end_datetime", "endsAt", "ends_at", "endTime", "end_time"),
      location: first(
        "venueName",
        "venue_name",
        "facilityName",
        "facility_name",
        "locationName",
        "location_name",
        "location",
        "venue"
      ),
      status: first("registrationStatus", "registration_status", "status"),
      keys: keys.slice(0, 20),
    };

    const identity = [
      candidate.source,
      candidate.id,
      candidate.title,
      candidate.start,
      candidate.location,
    ].join("|");

    if (!output.some((item) => item.identity === identity)) {
      output.push({ identity, ...candidate });
    }
  }

  for (const key of keys.slice(0, 100)) {
    extractJsonEventCandidates(value[key], sourceUrl, output, depth + 1);
  }
}

async function collectDomSnapshot(page, label) {
  return await page.evaluate((snapshotLabel) => {
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

    const sportSignal = /\b(?:soccer|pickleball)\b/i;
    const eventSignal =
      /\b(?:am|pm|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|pickup|drop-?in)\b/i;

    const all = [...document.querySelectorAll("body *")]
      .filter(isVisible)
      .map((element) => ({
        element,
        text: normalize(element.innerText || element.textContent),
      }))
      .filter(
        ({ text }) =>
          text.length >= 15 &&
          text.length <= 2_000 &&
          sportSignal.test(text) &&
          eventSignal.test(text)
      );

    const smallest = all.filter(
      ({ element, text }) =>
        !all.some(
          ({ element: other, text: otherText }) =>
            other !== element &&
            element.contains(other) &&
            otherText.length < text.length &&
            sportSignal.test(otherText) &&
            eventSignal.test(otherText)
        )
    );

    const cards = [];
    const seen = new Set();
    for (const { element, text } of smallest) {
      if (seen.has(text)) continue;
      seen.add(text);

      let link = element.closest("a[href]") || element.querySelector("a[href]");
      if (!link) {
        let parent = element.parentElement;
        for (let depth = 0; depth < 5 && parent && !link; depth += 1) {
          link = parent.matches("a[href]") ? parent : parent.querySelector("a[href]");
          parent = parent.parentElement;
        }
      }

      cards.push({
        text: text.slice(0, 700),
        url: link?.href || "",
      });
    }

    const controls = [
      ...document.querySelectorAll('button, a[href], [role="button"], [role="tab"]'),
    ]
      .filter(isVisible)
      .map((element) => ({
        text: normalize(
          element.innerText ||
            element.getAttribute("aria-label") ||
            element.textContent ||
            element.value
        ),
        href: element.href || "",
      }))
      .filter(({ text }) => text && text.length <= 120)
      .slice(0, 200);

    return {
      label: snapshotLabel,
      url: location.href,
      title: document.title,
      bodyHasSport: sportSignal.test(normalize(document.body?.innerText)),
      cards,
      controls,
    };
  }, label);
}

async function clickLikelyScheduleViews(page, snapshots) {
  const labels = [
    /^upcoming$/i,
    /^my schedule$/i,
    /^schedule$/i,
    /^daily sports$/i,
    /^drop-?ins?(?:\s*&\s*pickups?)?$/i,
    /^pickups?$/i,
  ];

  for (const pattern of labels) {
    const clickedLabel = await page.evaluate((source) => {
      const pattern = new RegExp(source, "i");
      const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
      const candidates = [
        ...document.querySelectorAll('button, a[href], [role="button"], [role="tab"]'),
      ];
      const target = candidates.find((element) =>
        pattern.test(
          normalize(
            element.innerText ||
              element.getAttribute("aria-label") ||
              element.textContent ||
              element.value
          )
        )
      );
      if (!target) return null;
      const label = normalize(
        target.innerText ||
          target.getAttribute("aria-label") ||
          target.textContent ||
          target.value
      );
      target.click();
      return label;
    }, pattern.source);

    if (!clickedLabel) continue;

    await page.waitForNetworkIdle({ idleTime: 750, timeout: 12_000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    snapshots.push(await collectDomSnapshot(page, `after clicking ${clickedLabel}`));
  }
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

  const apiResponses = [];
  const jsonEventCandidates = [];
  const snapshots = [];

  try {
    const page = await browser.newPage();
    await configurePage(page);

    page.on("response", async (response) => {
      try {
        const contentType = response.headers()["content-type"] || "";
        if (!/json/i.test(contentType)) return;

        const url = response.url();
        const text = await response.text();
        if (text.length > 2_500_000) return;
        if (
          !/\b(?:soccer|pickleball)\b/i.test(text) ||
          !/\b(?:game|pickup|drop.?in|registration|program|schedule|venue)\b/i.test(text)
        ) {
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }

        const topLevelKeys =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? Object.keys(parsed).slice(0, 30)
            : Array.isArray(parsed)
              ? [`array(${parsed.length})`]
              : [];

        const endpoint = safeUrl(url);
        if (!apiResponses.some((item) => item.endpoint === endpoint)) {
          apiResponses.push({
            endpoint,
            status: response.status(),
            topLevelKeys,
          });
        }

        extractJsonEventCandidates(parsed, url, jsonEventCandidates);
      } catch {
        // Some responses cannot be read twice or finish after the page closes.
      }
    });

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => {});
    await submitLogin(page);

    const loginStatus = await page.evaluate(() => ({
      url: location.href,
      body: String(document.body?.innerText ?? "").replace(/\s+/g, " ").trim(),
    }));

    if (
      /\/login(?:\/|$|\?)/i.test(loginStatus.url) ||
      /incorrect|invalid|unable to log in|wrong password/i.test(loginStatus.body)
    ) {
      throw new Error("Volo did not accept the stored email/password login.");
    }

    if (!/\/app\/dashboard(?:\/|$|\?)/i.test(page.url())) {
      await page.goto(DASHBOARD_URL, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
    }

    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 25_000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    await page.evaluate(async () => {
      for (let step = 0; step < 8; step += 1) {
        window.scrollBy(0, Math.max(window.innerHeight * 0.8, 700));
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      window.scrollTo(0, 0);
    });

    snapshots.push(await collectDomSnapshot(page, "dashboard initial view"));
    await clickLikelyScheduleViews(page, snapshots);

    const allCards = [];
    const seenCard = new Set();
    for (const snapshot of snapshots) {
      for (const card of snapshot.cards) {
        const identity = `${card.url}|${card.text}`;
        if (seenCard.has(identity)) continue;
        seenCard.add(identity);
        allCards.push({ snapshot: snapshot.label, ...card });
      }
    }

    return {
      finalUrl: page.url(),
      title: await page.title(),
      cards: allCards,
      snapshots: snapshots.map((snapshot) => ({
        label: snapshot.label,
        url: snapshot.url,
        bodyHasSport: snapshot.bodyHasSport,
        cardCount: snapshot.cards.length,
        relevantControls: snapshot.controls
          .filter((control) =>
            /upcoming|schedule|daily|pickup|drop-?in|soccer|pickleball/i.test(control.text)
          )
          .slice(0, 30),
      })),
      apiResponses,
      jsonEventCandidates: jsonEventCandidates.slice(0, 50),
    };
  } finally {
    await browser.close();
  }
}

function eventSummary(event) {
  const parts = [event.title, event.start, event.location, event.status].filter(Boolean);
  return parts.join(" | ") || `${event.id || "event"} from ${event.source}`;
}

async function main() {
  try {
    const [calendarName, dashboard] = await Promise.all([
      verifyCalendarAccess(),
      loginAndInspectDashboard(),
    ]);

    const domExamples = dashboard.cards
      .slice(0, 2)
      .map((card, index) => `${index + 1}. ${sanitize(card.text).slice(0, 300)}`)
      .join("\n");

    const apiExamples = dashboard.jsonEventCandidates
      .slice(0, 2)
      .map((event, index) => `${index + 1}. ${sanitize(eventSummary(event)).slice(0, 300)}`)
      .join("\n");

    const endpointExamples = dashboard.apiResponses
      .slice(0, 3)
      .map((item) => item.endpoint)
      .join("\n");

    const message = [
      `Google calendar access: OK (${calendarName}).`,
      `Volo login: OK.`,
      `Rendered session cards detected: ${dashboard.cards.length}.`,
      `API event candidates detected: ${dashboard.jsonEventCandidates.length}.`,
      domExamples
        ? `Rendered examples:\n${domExamples}`
        : apiExamples
          ? `API examples:\n${apiExamples}`
          : `Relevant API endpoints: ${dashboard.apiResponses.length}${
              endpointExamples ? `\n${endpointExamples}` : ""
            }`,
    ].join("\n");

    console.log(
      JSON.stringify(
        {
          calendarName,
          dashboardUrl: dashboard.finalUrl,
          pageTitle: dashboard.title,
          renderedCardCount: dashboard.cards.length,
          apiResponseCount: dashboard.apiResponses.length,
          apiEventCandidateCount: dashboard.jsonEventCandidates.length,
          snapshots: dashboard.snapshots,
          apiResponses: dashboard.apiResponses,
          apiEventCandidateFieldSummaries: dashboard.jsonEventCandidates.slice(0, 10).map(
            (event) => ({
              source: event.source,
              hasId: Boolean(event.id),
              hasTitle: Boolean(event.title),
              hasStart: Boolean(event.start),
              hasEnd: Boolean(event.end),
              hasLocation: Boolean(event.location),
              hasStatus: Boolean(event.status),
              keys: event.keys,
            })
          ),
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
      sanitize(message).slice(0, 600),
      "4",
      "calendar,warning"
    ).catch((notificationError) => {
      console.error("Could not send diagnostic failure notification:", notificationError);
    });
    process.exitCode = 1;
  }
}

await main();
