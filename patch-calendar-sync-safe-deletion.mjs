import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-sync.mjs";
let source = await readFile(path, "utf8");

function replaceBetween(text, startMarker, endMarker, replacement) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error(`Could not locate start marker: ${startMarker}`);
  const end = text.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Could not locate end marker: ${endMarker}`);
  return text.slice(0, start) + replacement + "\n\n" + text.slice(end);
}

if (!source.includes("const MISSING_CONFIRMATIONS_REQUIRED = 2;")) {
  const marker = "const DEFAULT_DURATION_MINUTES = 60;";
  if (!source.includes(marker)) {
    throw new Error("Run the sport-duration patch before the safe-deletion patch.");
  }
  source = source.replace(
    marker,
    `${marker}\nconst MISSING_CONFIRMATIONS_REQUIRED = 2;`
  );
}

const durationProperty = `        voloDurationMinutes: String(session.durationMinutes),`;
const deletionProperties = `${durationProperty}\n        voloMissingCount: "0",\n        voloMissingSince: "none",`;
if (!source.includes('voloMissingCount: "0"')) {
  if (!source.includes(durationProperty)) {
    throw new Error("Could not locate pickup event duration metadata.");
  }
  source = source.replace(durationProperty, deletionProperties);
}

const syncReplacement = `async function syncSessions(sessions) {
  const existing = await listManagedEvents();
  const byRouteId = new Map();
  for (const event of existing) {
    const routeId = event.extendedProperties?.private?.voloRouteId;
    if (routeId && !byRouteId.has(routeId)) byRouteId.set(routeId, event);
  }

  const presentRouteIds = new Set(sessions.map((session) => session.routeId));
  const actions = [];

  for (const session of sessions) {
    const body = eventBody(session);
    const current = byRouteId.get(session.routeId);

    if (!current) {
      actions.push({ type: "create", session, body });
      if (!DRY_RUN) {
        await calendarRequest(calendarUrl("/events"), {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      continue;
    }

    if (comparableEvent(current) !== comparableEvent(body)) {
      actions.push({ type: "update", session, body, eventId: current.id });
      if (!DRY_RUN) {
        await calendarRequest(calendarUrl(\`/events/\${encodeURIComponent(current.id)}\`), {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      }
    } else {
      actions.push({ type: "unchanged", session, eventId: current.id });
    }
  }

  for (const event of existing) {
    const privateProperties = event.extendedProperties?.private || {};
    const routeId = privateProperties.voloRouteId;
    if (!routeId || presentRouteIds.has(routeId)) continue;

    const parsedMissingCount = Number.parseInt(privateProperties.voloMissingCount || "0", 10);
    const previousMissingCount = Number.isFinite(parsedMissingCount) ? parsedMissingCount : 0;
    const nextMissingCount = previousMissingCount + 1;
    const startTimestamp = Date.parse(event.start?.dateTime || "");
    const durationMinutes = Number.parseInt(privateProperties.voloDurationMinutes || "60", 10);
    const session = {
      routeId,
      activity: event.summary || "Volo Sports Session",
      location: event.location || "",
      startTimestamp: Number.isFinite(startTimestamp) ? startTimestamp : Date.now(),
      durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : 60,
    };

    if (nextMissingCount < MISSING_CONFIRMATIONS_REQUIRED) {
      actions.push({
        type: "missing-confirmation",
        session,
        eventId: event.id,
        missingCount: nextMissingCount,
      });

      if (!DRY_RUN) {
        await calendarRequest(calendarUrl(\`/events/\${encodeURIComponent(event.id)}\`), {
          method: "PATCH",
          body: JSON.stringify({
            extendedProperties: {
              private: {
                ...privateProperties,
                voloMissingCount: String(nextMissingCount),
                voloMissingSince:
                  privateProperties.voloMissingSince && privateProperties.voloMissingSince !== "none"
                    ? privateProperties.voloMissingSince
                    : new Date().toISOString(),
              },
            },
          }),
        });
      }
      continue;
    }

    actions.push({ type: "delete", session, eventId: event.id });
    if (!DRY_RUN) {
      await calendarRequest(calendarUrl(\`/events/\${encodeURIComponent(event.id)}\`), {
        method: "DELETE",
      });
    }
  }

  return { actions, existingCount: existing.length };
}`;

source = replaceBetween(
  source,
  "async function syncSessions(sessions) {",
  "function formatDenverTime(timestamp) {",
  syncReplacement
);

const unchangedCountLine = `    const unchanged = result.actions.filter((action) => action.type === "unchanged");`;
const expandedCounts = `${unchangedCountLine}\n    const missingConfirmations = result.actions.filter(\n      (action) => action.type === "missing-confirmation"\n    );\n    const deleted = result.actions.filter((action) => action.type === "delete");`;
if (!source.includes("const missingConfirmations =")) {
  if (!source.includes(unchangedCountLine)) throw new Error("Could not locate pickup action counts.");
  source = source.replace(unchangedCountLine, expandedCounts);
}

source = source.replace(
  "const actionExamples = [...created, ...updated]",
  "const actionExamples = [...created, ...updated, ...missingConfirmations, ...deleted]"
);
source = source.replace(
  'DRY_RUN ? "Dry run: no calendar changes were made." : "Calendar create/update sync completed.",',
  'DRY_RUN ? "Dry run: no calendar changes were made." : "Calendar create/update/deletion sync completed.",'
);
source = source.replace(
  '`Created: ${created.length}. Updated: ${updated.length}. Unchanged: ${unchanged.length}.`,',
  '`Created: ${created.length}. Updated: ${updated.length}. Unchanged: ${unchanged.length}. Missing confirmations: ${missingConfirmations.length}. Deleted: ${deleted.length}.`,'
);
source = source.replace(
  '"Deletion sync is disabled.",',
  '"Safe deletion is enabled: an event must be missing on two consecutive successful Volo reads.",'
);
source = source.replace(
  "          deletionEnabled: false,",
  "          missingConfirmationCount: missingConfirmations.length,\n          deletedCount: deleted.length,\n          deletionConfirmationsRequired: MISSING_CONFIRMATIONS_REQUIRED,\n          deletionEnabled: true,"
);
source = source.replace(
  "if (DRY_RUN || created.length > 0 || updated.length > 0) {",
  "if (\n      DRY_RUN ||\n      created.length > 0 ||\n      updated.length > 0 ||\n      missingConfirmations.length > 0 ||\n      deleted.length > 0\n    ) {"
);

await writeFile(path, source, "utf8");
console.log("Applied two-consecutive-read safe deletion to pickup calendar sync.");
