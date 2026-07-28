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

function registrationEvidenceText(event) {
  return [
    event.source,
    event.status,
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

function isUserScopedCandidate(event) {
  const evidence = registrationEvidenceText(event);
  return /registration(?:_|\\b)|registered|participant|attendee|roster|signup|sign_up|reservation|booking|enrollment|enrolled|order(?:_|\\b)|user.?program|my.?schedule|dashboard/i.test(
    evidence
  );
}

function isLikelyDailyRegistration(event) {
  if (!isFutureCandidate(event) || !isUserScopedCandidate(event)) return false;
  const text = candidateSearchText(event);
  const dailySignal = /pickup|drop.?in|daily.?sport|single.?game|game.?registration/i.test(text);
  const activeStatus = !/cancel|withdraw|refund|inactive|deleted|expired/i.test(event.status || "");
  return dailySignal && activeStatus;
}

function evidenceSummary(event) {
  const keys = Array.isArray(event.keys) ? event.keys.slice(0, 12).join(", ") : "none";
  return [
    sanitize(eventSummary(event)).slice(0, 260),
    \`Endpoint: \${sanitize(event.source)}\`,
    \`ID present: \${event.id ? "yes" : "no"}; keys: \${sanitize(keys)}\`,
  ].join("\\n");
}

function publicEvidence(event) {
  return {
    source: event.source,
    hasId: Boolean(event.id),
    hasStart: Boolean(event.start),
    status: event.status || null,
    keys: Array.isArray(event.keys) ? event.keys : [],
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
    const userScopedCandidates = futureCandidates.filter(isUserScopedCandidate);
    const likelyDailyRegistrations = futureCandidates.filter(isLikelyDailyRegistration);

    const examples = (likelyDailyRegistrations.length
      ? likelyDailyRegistrations
      : userScopedCandidates.length
        ? userScopedCandidates
        : futureCandidates
    )
      .slice(0, 5)
      .map((event, index) => \`\${index + 1}. \${evidenceSummary(event)}\`)
      .join("\\n\\n");

    const message = [
      \`Google calendar access: OK (\${calendarName}).\`,
      "Volo login: OK.",
      \`Future dated API candidates: \${futureCandidates.length}.\`,
      \`User-scoped future candidates: \${userScopedCandidates.length}.\`,
      \`Likely upcoming daily registrations: \${likelyDailyRegistrations.length}.\`,
      examples ? \`Registration evidence examples:\\n\${examples}\` : "No future candidates were found.",
    ].join("\\n");

    // This repository is public. Log only field names and endpoint paths, not
    // private event titles, locations, registration IDs, or user information.
    console.log(
      JSON.stringify(
        {
          calendarName,
          dashboardUrl: dashboard.finalUrl,
          renderedCardCount: dashboard.cards.length,
          apiResponseCount: dashboard.apiResponses.length,
          apiEventCandidateCount: dashboard.jsonEventCandidates.length,
          futureCandidateCount: futureCandidates.length,
          userScopedCandidateCount: userScopedCandidates.length,
          likelyDailyRegistrationCount: likelyDailyRegistrations.length,
          futureCandidateEvidence: futureCandidates.slice(0, 20).map(publicEvidence),
          apiResponses: dashboard.apiResponses,
        },
        null,
        2
      )
    );

    await notify("Volo registration evidence diagnostic", message);
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
console.log("Applied user-registration evidence diagnostic.");
