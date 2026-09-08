import { readFile, writeFile } from "node:fs/promises";

const path = "monitor.mjs";
let source = await readFile(path, "utf8");

const ntfyLine = 'const NTFY_TOPIC = requiredEnv("NTFY_TOPIC");';
if (!source.includes('const VOLO_EMAIL = requiredEnv("VOLO_EMAIL");')) {
  if (!source.includes(ntfyLine)) {
    throw new Error("Could not locate NTFY_TOPIC declaration in monitor.mjs");
  }
  source = source.replace(
    ntfyLine,
    [
      ntfyLine,
      'const VOLO_EMAIL = requiredEnv("VOLO_EMAIL");',
      'const VOLO_PASSWORD = requiredEnv("VOLO_PASSWORD");',
    ].join("\n")
  );
}

const scrapeMarker = "async function scrapeMatches() {";
if (!source.includes("async function loginToVolo(page) {")) {
  if (!source.includes(scrapeMarker)) {
    throw new Error("Could not locate scrapeMatches in monitor.mjs");
  }

  const helper = [
    'async function firstExistingSelector(page, selectors) {',
    '  for (const selector of selectors) {',
    '    if (await page.$(selector)) return selector;',
    '  }',
    '  return null;',
    '}',
    '',
    'async function loginToVolo(page) {',
    '  await page.goto("https://www.volosports.com/login", {',
    '    waitUntil: "domcontentloaded",',
    '    timeout: 120_000,',
    '  });',
    '  await page.waitForNetworkIdle({ idleTime: 750, timeout: 20_000 }).catch(() => {});',
    '',
    '  const emailSelector = await firstExistingSelector(page, [',
    '    \'input[type="email"]\',',
    '    \'input[name="email"]\',',
    '    \'input[name="username"]\',',
    '    \'input[autocomplete="username"]\',',
    '  ]);',
    '  const passwordSelector = await firstExistingSelector(page, [',
    '    \'input[type="password"]\',',
    '    \'input[name="password"]\',',
    '    \'input[autocomplete="current-password"]\',',
    '  ]);',
    '',
    '  if (!emailSelector || !passwordSelector) {',
    '    throw new Error("Could not find Volo login fields for authenticated monitoring.");',
    '  }',
    '',
    '  await page.click(emailSelector, { clickCount: 3 });',
    '  await page.type(emailSelector, VOLO_EMAIL, { delay: 10 });',
    '  await page.click(passwordSelector, { clickCount: 3 });',
    '  await page.type(passwordSelector, VOLO_PASSWORD, { delay: 10 });',
    '',
    '  const navigation = page',
    '    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45_000 })',
    '    .catch(() => null);',
    '',
    '  const clicked = await page.evaluate(() => {',
    '    const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();',
    '    const controls = [...document.querySelectorAll(\'button, input[type="submit"], [role="button"]\')];',
    '    const target = controls.find((element) =>',
    '      /^(?:log in with email|log in|sign in)$/i.test(',
    '        normalize(element.innerText || element.value || element.textContent)',
    '      )',
    '    );',
    '    if (!target) return false;',
    '    target.click();',
    '    return true;',
    '  });',
    '',
    '  if (!clicked) await page.press(passwordSelector, "Enter");',
    '  await navigation;',
    '  await page.waitForNetworkIdle({ idleTime: 750, timeout: 20_000 }).catch(() => {});',
    '  await new Promise((resolve) => setTimeout(resolve, 1_500));',
    '',
    '  const status = await page.evaluate(() => ({',
    '    url: location.href,',
    '    body: String(document.body?.innerText ?? "").replace(/\\s+/g, " ").trim(),',
    '  }));',
    '',
    '  if (',
    '    /\\/login(?:\\/|$|\\?)/i.test(status.url) ||',
    '    /incorrect|invalid|unable to log in|wrong password/i.test(status.body)',
    '  ) {',
    '    throw new Error("Volo did not accept the stored login for authenticated monitoring.");',
    '  }',
    '',
    '  console.log("Authenticated Volo session established for soccer monitoring.");',
    '}',
    '',
  ].join("\n");

  source = source.replace(scrapeMarker, helper + scrapeMarker);
}

const discoverGoto = [
  '    await page.goto(VOLO_URL, {',
  '      waitUntil: "domcontentloaded",',
  '      timeout: 45_000,',
  '    });',
].join("\n");

if (!source.includes("await loginToVolo(page);")) {
  if (!source.includes(discoverGoto)) {
    throw new Error("Could not locate Discover navigation in monitor.mjs");
  }
  source = source.replace(
    discoverGoto,
    [
      '    await loginToVolo(page);',
      '',
      '    await page.goto(VOLO_URL, {',
      '      waitUntil: "domcontentloaded",',
      '      timeout: 120_000,',
      '    });',
    ].join("\n")
  );
}

await writeFile(path, source, "utf8");
console.log("Enabled authenticated Volo session for soccer availability checks.");
