import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-rsvp-detail-diagnostic.mjs";
let source = await readFile(path, "utf8");

const oldTimestamp = `function parseTimestamp(value) {
  if (typeof value === "number") {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const timestamp = Date.parse(normalize(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}`;

const newTimestamp = `function parseTimestamp(value) {
  const text = normalize(value);
  if (!text) return null;

  if (typeof value === "number" || /^-?\\d+(?:\\.\\d+)?$/.test(text)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;

    // Treat only plausible Unix timestamps as complete dates. Smaller values
    // are commonly time-of-day values and must not be interpreted as 1970.
    if (numeric >= 1_000_000_000_000) return numeric;
    if (numeric >= 1_000_000_000) return numeric * 1_000;
    return null;
  }

  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}`;

if (!source.includes(newTimestamp)) {
  if (!source.includes(oldTimestamp)) {
    throw new Error("Could not locate RSVP timestamp parser.");
  }
  source = source.replace(oldTimestamp, newTimestamp);
}

const oldRsvpPush = `    if (registrantId && gameId && startTimestamp !== null) {
      const identity = \`\${registrantId}|\${gameId}|\${startTimestamp}\`;
      if (!output.some((item) => item.identity === identity)) {
        output.push({ identity, registrantId, gameId, startRaw, startTimestamp });
      }
    }`;

const newRsvpPush = `    if (registrantId && gameId) {
      const identity = \`\${registrantId}|\${gameId}\`;
      if (!output.some((item) => item.identity === identity)) {
        output.push({ identity, registrantId, gameId, startRaw, startTimestamp });
      }
    }`;

if (!source.includes(newRsvpPush)) {
  if (!source.includes(oldRsvpPush)) {
    throw new Error("Could not locate RSVP extraction block.");
  }
  source = source.replace(oldRsvpPush, newRsvpPush);
}

const helperMarker = `async function inspect() {`;
if (!source.includes("function parseDashboardLocalDate(")) {
  if (!source.includes(helperMarker)) {
    throw new Error("Could not locate RSVP inspection function.");
  }

  const helpers = `function denverClockParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
  };
}

function localSortValue(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
}

function parseDashboardLocalDate(text) {
  const normalized = normalize(text);
  const match = normalized.match(
    /\\b(\\d{1,2})\\/(\\d{1,2})\\b[\\s\\S]*?\\b(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\b/i
  );
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  let hour = Number(match[3]);
  const minute = Number(match[4] || 0);
  const meridiem = match[5].toLowerCase();
  if (hour === 12) hour = 0;
  if (meridiem === "pm") hour += 12;

  const current = denverClockParts();
  const nowSort = localSortValue(current);
  let year = current.year;
  let sortValue = localSortValue({ year, month, day, hour, minute });
  const halfYear = 183 * 24 * 60 * 60 * 1_000;
  if (sortValue < nowSort - halfYear) year += 1;
  else if (sortValue > nowSort + halfYear) year -= 1;
  sortValue = localSortValue({ year, month, day, hour, minute });

  const hour12 = hour % 12 || 12;
  const suffix = hour >= 12 ? "PM" : "AM";
  return {
    year,
    month,
    day,
    hour,
    minute,
    sortValue,
    localDateTime: \`\${year}-\${String(month).padStart(2, "0")}-\${String(day).padStart(2, "0")}T\${String(hour).padStart(2, "0")}:\${String(minute).padStart(2, "0")}:00\`,
    display: \`\${month}/\${day}/\${year} \${hour12}:\${String(minute).padStart(2, "0")} \${suffix}\`,
  };
}

`;

  source = source.replace(helperMarker, helpers + helperMarker);
}

const oldUpcoming = `    const memberLinks = await collectMemberLinks(page);
    const now = Date.now() - 6 * 60 * 60 * 1_000;
    const upcoming = rsvps
      .filter((item) => item.startTimestamp >= now)
      .sort((a, b) => a.startTimestamp - b.startTimestamp)
      .slice(0, 15);`;

const newUpcoming = `    const memberLinks = await collectMemberLinks(page);
    const currentDenver = denverClockParts();
    const nowLocalSort = localSortValue(currentDenver) - 6 * 60 * 60 * 1_000;
    const nowEpoch = Date.now() - 6 * 60 * 60 * 1_000;

    const dashboardMatched = rsvps
      .map((rsvp) => {
        const link = memberLinks.find((item) => item.registrantId === rsvp.registrantId);
        const dashboardLocal = link ? parseDashboardLocalDate(link.text) : null;
        return { ...rsvp, link, dashboardLocal };
      })
      .filter((item) => item.link);

    const upcoming = dashboardMatched
      .filter(
        (item) =>
          (item.dashboardLocal && item.dashboardLocal.sortValue >= nowLocalSort) ||
          (item.startTimestamp !== null && item.startTimestamp >= nowEpoch)
      )
      .sort(
        (a, b) =>
          (a.dashboardLocal?.sortValue ?? a.startTimestamp ?? Number.MAX_SAFE_INTEGER) -
          (b.dashboardLocal?.sortValue ?? b.startTimestamp ?? Number.MAX_SAFE_INTEGER)
      )
      .slice(0, 15);`;

if (!source.includes(newUpcoming)) {
  if (!source.includes(oldUpcoming)) {
    throw new Error("Could not locate upcoming RSVP calculation.");
  }
  source = source.replace(oldUpcoming, newUpcoming);
}

const oldLinkLookup = `      const link = memberLinks.find((item) => item.registrantId === rsvp.registrantId);`;
const newLinkLookup = `      const link = rsvp.link || memberLinks.find((item) => item.registrantId === rsvp.registrantId);`;
if (!source.includes(newLinkLookup)) {
  if (!source.includes(oldLinkLookup)) {
    throw new Error("Could not locate member-link lookup.");
  }
  source = source.replace(oldLinkLookup, newLinkLookup);
}

const oldReturn = `    return { rsvps, upcoming, memberLinks, details, detailCaptures };`;
const newReturn = `    return { rsvps, dashboardMatched, upcoming, memberLinks, details, detailCaptures };`;
if (!source.includes(newReturn)) {
  if (!source.includes(oldReturn)) throw new Error("Could not locate diagnostic return value.");
  source = source.replace(oldReturn, newReturn);
}

const oldExample = `      return \`\${index + 1}. \${sanitize(label).slice(0, 420)} | \${formatDenverTime(item.startTimestamp)}\`;`;
const newExample = `      const when = item.dashboardLocal?.display ||
        (item.startTimestamp !== null ? formatDenverTime(item.startTimestamp) : "time unavailable");
      return \`\${index + 1}. \${sanitize(label).slice(0, 420)} | \${when}\`;`;
if (!source.includes(newExample)) {
  if (!source.includes(oldExample)) throw new Error("Could not locate RSVP example formatter.");
  source = source.replace(oldExample, newExample);
}

const oldSchemaSource = `    const schemaLines = diagnostic.details
      .flatMap((detail) => detail.schema)`;
const newSchemaSource = `    const schemaLines = diagnostic.detailCaptures
      .flatMap((capture) => capture.schema)`;
if (!source.includes(newSchemaSource)) {
  if (!source.includes(oldSchemaSource)) throw new Error("Could not locate detail schema source.");
  source = source.replace(oldSchemaSource, newSchemaSource);
}

const oldMessageCounts = `      \`myDropInRsvps registrations found: \${diagnostic.rsvps.length}.\`,
      \`Upcoming registrations found: \${diagnostic.upcoming.length}.\`,
      \`Dashboard member links found: \${diagnostic.memberLinks.length}.\`,`;
const newMessageCounts = `      \`myDropInRsvps registrations found: \${diagnostic.rsvps.length}.\`,
      \`RSVPs matched to dashboard cards: \${diagnostic.dashboardMatched.length}.\`,
      \`Upcoming registrations found: \${diagnostic.upcoming.length}.\`,
      \`Dashboard member links found: \${diagnostic.memberLinks.length}.\`,`;
if (!source.includes(newMessageCounts)) {
  if (!source.includes(oldMessageCounts)) throw new Error("Could not locate notification counts.");
  source = source.replace(oldMessageCounts, newMessageCounts);
}

const oldLogCounts = `          rsvpCount: diagnostic.rsvps.length,
          upcomingCount: diagnostic.upcoming.length,`;
const newLogCounts = `          rsvpCount: diagnostic.rsvps.length,
          dashboardMatchedCount: diagnostic.dashboardMatched.length,
          rsvpFullTimestampCount: diagnostic.rsvps.filter((item) => item.startTimestamp !== null).length,
          upcomingCount: diagnostic.upcoming.length,`;
if (!source.includes(newLogCounts)) {
  if (!source.includes(oldLogCounts)) throw new Error("Could not locate console counts.");
  source = source.replace(oldLogCounts, newLogCounts);
}

await writeFile(path, source, "utf8");
console.log("Applied dashboard-date matching for Volo RSVP diagnostics.");
