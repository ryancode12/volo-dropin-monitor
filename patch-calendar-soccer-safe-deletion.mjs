import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-soccer-sync.mjs";
let source = await readFile(path, "utf8");

function replaceBetween(text, startMarker, endMarker, replacement) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error(`Could not locate start marker: ${startMarker}`);
  const end = text.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Could not locate end marker: ${endMarker}`);
  return text.slice(0, start) + replacement + "\n\n" + text.slice(end);
}

if (!source.includes("const MISSING_CONFIRMATIONS_REQUIRED = 2;")) {
  const marker = "const SOCCER_DURATION_MINUTES = 45;";
  if (!source.includes(marker)) throw new Error("Could not locate soccer duration constant.");
  source = source.replace(
    marker,
    `${marker}\nconst MISSING_CONFIRMATIONS_REQUIRED = 2;`
  );
}

source = source.replace(
  `          const games = [];
          collectGameObjects(responseItems[index] ?? responseItems[0], games);
          if (games.length === 0) continue;

          captures.push({`,
  `          const games = [];
          collectGameObjects(responseItems[index] ?? responseItems[0], games);

          captures.push({`
);

const programsLine = `    const programs = await collectSoccerCards(page);`;
const programsExpanded = `${programsLine}
    const dashboardCardCount = await page.evaluate(() => {
      const routeIds = new Set();
      for (const link of document.querySelectorAll('a[href*="/app/member/"]')) {
        const match = link.href.match(/\\/app\\/member\\/([^/?#]+)/i);
        if (match?.[1]) routeIds.add(match[1]);
      }
      return routeIds.size;
    });`;
if (!source.includes("const dashboardCardCount =")) {
  if (!source.includes(programsLine)) throw new Error("Could not locate soccer program collection.");
  source = source.replace(programsLine, programsExpanded);
}

const oldReturn = `    return {
      programCount: programs.length,
      captureCount: captures.length,
      games: [...byIdentity.values()].sort((left, right) => left.startTimestamp - right.startTimestamp),
    };`;
const newReturn = `    return {
      dashboardCardCount,
      programCount: programs.length,
      captureCount: captures.length,
      programRouteIds: programs.map((program) => program.routeId),
      capturedRouteIds: [...new Set(captures.map((capture) => capture.program.routeId))],
      games: [...byIdentity.values()].sort((left, right) => left.startTimestamp - right.startTimestamp),
    };`;
if (!source.includes("capturedRouteIds:")) {
  if (!source.includes(oldReturn)) throw new Error("Could not locate soccer source return block.");
  source = source.replace(oldReturn, newReturn);
}

const durationProperty = `        voloDurationMinutes: String(SOCCER_DURATION_MINUTES),`;
const deletionProperties = `${durationProperty}\n        voloMissingCount: "0",\n        voloMissingSince: "none",`;
if (!source.includes('voloMissingCount: "0"')) {
  if (!source.includes(durationProperty)) throw new Error("Could not locate soccer duration metadata.");
  source = source.replace(durationProperty, deletionProperties);
}

const syncReplacement = `async function syncSoccerGames(games, sourceState) {
  const existing = await listManagedSoccerEvents();
  const byGameKey = new Map();

  for (const event of existing) {
    const gameKey = event.extendedProperties?.private?.voloGameKey;
    if (gameKey && !byGameKey.has(gameKey)) byGameKey.set(gameKey, event);
  }

  const presentGameKeys = new Set(games.map((game) => game.gameKey));
  const currentProgramRouteIds = new Set(sourceState.programRouteIds || []);
  const capturedRouteIds = new Set(sourceState.capturedRouteIds || []);
  const actions = [];

  for (const game of games) {
    const body = eventBody(game);
    const current = byGameKey.get(game.gameKey);

    if (!current) {
      actions.push({ type: "create", game, body });
      if (!DRY_RUN) {
        await calendarRequest(calendarUrl("/events"), {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      continue;
    }

    if (comparableEvent(current) !== comparableEvent(body)) {
      actions.push({ type: "update", game, body, eventId: current.id });
      if (!DRY_RUN) {
        await calendarRequest(calendarUrl(\`/events/\${encodeURIComponent(current.id)}\`), {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      }
    } else {
      actions.push({ type: "unchanged", game, eventId: current.id });
    }
  }

  for (const event of existing) {
    const privateProperties = event.extendedProperties?.private || {};
    const gameKey = privateProperties.voloGameKey;
    const routeId = privateProperties.voloProgramRouteId;
    if (!gameKey || presentGameKeys.has(gameKey) || !routeId) continue;

    const programStillPresent = currentProgramRouteIds.has(routeId);
    if (programStillPresent && !capturedRouteIds.has(routeId)) {
      continue;
    }

    const parsedMissingCount = Number.parseInt(privateProperties.voloMissingCount || "0", 10);
    const previousMissingCount = Number.isFinite(parsedMissingCount) ? parsedMissingCount : 0;
    const nextMissingCount = previousMissingCount + 1;
    const startTimestamp = Date.parse(event.start?.dateTime || "");
    const teamName = normalize((event.summary || "Soccer").replace(/^Soccer\s*[—-]\s*/i, ""));
    const game = {
      gameKey,
      routeId,
      teamName: teamName || "Soccer",
      location: event.location || "",
      startTimestamp: Number.isFinite(startTimestamp) ? startTimestamp : Date.now(),
    };

    if (nextMissingCount < MISSING_CONFIRMATIONS_REQUIRED) {
      actions.push({
        type: "missing-confirmation",
        game,
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

    actions.push({ type: "delete", game, eventId: event.id });
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
  "async function syncSoccerGames(games) {",
  "function formatDenverTime(timestamp) {",
  syncReplacement
);

const oldValidation = `    if (dashboard.programCount === 0) {
      throw new Error("Volo login succeeded, but no authenticated soccer program cards were found.");
    }

    const result = await syncSoccerGames(dashboard.games);`;
const newValidation = `    if (dashboard.dashboardCardCount === 0) {
      throw new Error("Volo login succeeded, but no authenticated dashboard member cards were found.");
    }
    if (dashboard.programCount > 0 && dashboard.captureCount === 0) {
      throw new Error("Soccer program cards were found, but no schedule responses were captured. Deletion was skipped.");
    }

    const result = await syncSoccerGames(dashboard.games, dashboard);`;
if (!source.includes("dashboard.captureCount === 0")) {
  if (!source.includes(oldValidation)) throw new Error("Could not locate soccer source validation.");
  source = source.replace(oldValidation, newValidation);
}

const unchangedCountLine = `    const unchanged = result.actions.filter((action) => action.type === "unchanged");`;
const expandedCounts = `${unchangedCountLine}\n    const missingConfirmations = result.actions.filter(\n      (action) => action.type === "missing-confirmation"\n    );\n    const deleted = result.actions.filter((action) => action.type === "delete");`;
if (!source.includes("const missingConfirmations =")) {
  if (!source.includes(unchangedCountLine)) throw new Error("Could not locate soccer action counts.");
  source = source.replace(unchangedCountLine, expandedCounts);
}

source = source.replace(
  "const actionExamples = [...created, ...updated]",
  "const actionExamples = [...created, ...updated, ...missingConfirmations, ...deleted]"
);
source = source.replace(
  'DRY_RUN ? "Dry run: no soccer calendar changes were made." : "Soccer calendar create/update sync completed.",',
  'DRY_RUN ? "Dry run: no soccer calendar changes were made." : "Soccer calendar create/update/deletion sync completed.",'
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
console.log("Applied two-consecutive-read safe deletion to soccer calendar sync.");
