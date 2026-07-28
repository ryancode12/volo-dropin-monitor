import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-diagnostic.mjs";
let source = await readFile(path, "utf8");

const marker = "function eventSummary(event) {";
const start = source.indexOf(marker);
if (start === -1) {
  throw new Error("Could not locate calendar diagnostic summary section.");
}

const replacement = `function eventSummary(event) {
  const parts = [event.title, event.start, event.location, event.status].filter(Boolean);
  return parts.join(" | ") || \`\${event.id || "event"} from \${event.source}\`;
}

function parseCandidateDate(value) {
  const text = normalizeText(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function candidateSearchText(event) {
  return [
    event.title,
    event.start,
    event.location,
    event.status,
    event.source,
    ...(Array.isArray(event.keys) ? event.keys : []),
  ]
    .filter(Boolean)
    .join(" ");
}

function isFutureCandidate(event) {
  const timestamp = parseCandidateDate(event.start);
  if (timestamp === null) return false;
  const lowerBound = Date.now() - 12 * 60 * 60 * 1000;
  const upperBound = Date.now() + 120 * 24 * 60 * 60 * 1000;
  return timestamp >= lowerBound && timestamp <= upperBound;
}

function isLikelyDailyRegistration(event) {
  if (!isFutureCandidate(event)) return false;
  const text = candidateSearchText(event);
  const dailySignal = /pickup|drop.?in|daily.?sport|single.?game|game.?registration/i.test(text);
  const registrationSignal = /register|participant|member|signup|roster|reservation|booking|dashboard|schedule/i.test(text);
  const activeStatus = !/cancel|withdraw|refund|inactive|deleted|expired/i.test(event.status || "");
  return dailySignal && registrationSignal && activeStatus;
}

function diagnosticCandidate(event) {
  return {
    id: event.id || null,
    title: event.title || null,
    start: event.start || null,
    end: event.end || null,
    location: event.location || null,
    status: event.status || null,
    source: event.source,
    keys: event.keys,
  };
}

async function main() {
  try {
    const [calendarName, dashboard] = await Promise.all([
      verifyCalendarAccess(),
      loginAndInspectDashboard(),
    ]);

    const futureCandidates = dashboard.jsonEventCandidates
      .filter(isFutureCandidate)
      .sort((a, b) => parseCandidateDate(a.start) - parseCandidateDate(b.start));
    const likelyDailyRegistrations = futureCandidates.filter(isLikelyDailyRegistration);

    const candidateExamples = (likelyDailyRegistrations.length
      ? likelyDailyRegistrations
      : futureCandidates
    )
      .slice(0, 5)
      .map((event, index) => \`\${index + 1}. \${sanitize(eventSummary(event)).slice(0, 350)}\`)
      .join("\\n");

    const message = [
      \`Google calendar access: OK (\${calendarName}).\`,
      "Volo login: OK.",
      \`Rendered session cards detected: \${dashboard.cards.length}.\`,
      \`API event candidates detected: \${dashboard.jsonEventCandidates.length}.\`,
      \`Future dated API candidates: \${futureCandidates.length}.\`,
      \`Likely upcoming daily registrations: \${likelyDailyRegistrations.length}.\`,
      candidateExamples
        ? \`Best structured examples:\\n\${candidateExamples}\`
        : "No parseable future registration candidates were found.",
    ].join("\\n");

    console.log(
      JSON.stringify(
        {
          calendarName,
          dashboardUrl: dashboard.finalUrl,
          pageTitle: dashboard.title,
          renderedCardCount: dashboard.cards.length,
          apiResponseCount: dashboard.apiResponses.length,
          apiEventCandidateCount: dashboard.jsonEventCandidates.length,
          futureCandidates: futureCandidates.slice(0, 30).map(diagnosticCandidate),
          likelyDailyRegistrations: likelyDailyRegistrations.slice(0, 30).map(diagnosticCandidate),
          snapshots: dashboard.snapshots,
          apiResponses: dashboard.apiResponses,
        },
        null,
        2
      )
    );

    await notify("Volo calendar targeting diagnostic", message);
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
`;

source = source.slice(0, start) + replacement;
await writeFile(path, source, "utf8");
console.log("Applied targeted upcoming-registration calendar diagnostic.");
