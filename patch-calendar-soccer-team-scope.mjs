import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-soccer-sync.mjs";
let source = await readFile(path, "utf8");

const oldOperationFilter = `function isSoccerScheduleOperation(operationName) {
  return /^(?:TeamGames|getTeamSchedule|GetLeaguePlayerSchedule|TournamentSchedule|getGame)$/i.test(
    operationName
  );
}`;
const strictOperationFilter = `function isSoccerScheduleOperation(operationName) {
  // Only operations explicitly scoped by teamId are safe for calendar sync.
  // League-wide and single-game operations can contain games for other teams.
  return /^(?:TeamGames|getTeamSchedule)$/i.test(operationName);
}`;
if (!source.includes(strictOperationFilter)) {
  if (!source.includes(oldOperationFilter)) {
    throw new Error("Could not locate the soccer schedule-operation filter.");
  }
  source = source.replace(oldOperationFilter, strictOperationFilter);
}

const oldCaptureBlock = `        for (let index = 0; index < payloads.length; index += 1) {
          const operationName = normalize(payloads[index]?.operationName);
          if (!isSoccerScheduleOperation(operationName)) continue;

          const games = [];
          collectGameObjects(responseItems[index] ?? responseItems[0], games);

          captures.push({
            operationName,
            program: programSnapshot,
            games,
          });
        }`;
const strictCaptureBlock = `        for (let index = 0; index < payloads.length; index += 1) {
          const payload = payloads[index] || {};
          const operationName = normalize(payload.operationName);
          if (!isSoccerScheduleOperation(operationName)) continue;

          const teamId = normalize(payload.variables?.teamId);
          if (!teamId) continue;

          const games = [];
          collectGameObjects(responseItems[index] ?? responseItems[0], games);

          captures.push({
            operationName,
            teamId,
            program: programSnapshot,
            games,
          });
        }`;
if (!source.includes("const teamId = normalize(payload.variables?.teamId);")) {
  if (!source.includes(oldCaptureBlock)) {
    throw new Error("Could not locate the soccer GraphQL capture block after safe-deletion patching.");
  }
  source = source.replace(oldCaptureBlock, strictCaptureBlock);
}

const oldIdentityBlock = `        const fallbackIdentity = hashText(
          \`${"${capture.program.routeId}|${game.startTimestamp}|${game.fieldName}|${capture.program.teamName}"}\`
        );
        const gameKey = game.gameId || fallbackIdentity;`;
const canonicalIdentityBlock = `        const gameKey = canonicalSoccerGameKey({
          routeId: capture.program.routeId,
          startTimestamp: game.startTimestamp,
          teamName: capture.program.teamName,
        });`;
if (!source.includes("const gameKey = canonicalSoccerGameKey({")) {
  if (!source.includes(oldIdentityBlock)) {
    throw new Error("Could not locate the soccer game identity block.");
  }
  source = source.replace(oldIdentityBlock, canonicalIdentityBlock);
}

if (!source.includes("function canonicalSoccerGameKey(")) {
  const marker = `function eventBody(game) {`;
  const helpers = `function canonicalSoccerGameKey({ routeId, startTimestamp, teamName }) {
  // A user team cannot have two distinct games at the exact same instant.
  // Excluding field text makes migration stable when Volo omits or renames a field.
  return hashText(
    [
      normalize(routeId).toLowerCase(),
      String(startTimestamp),
      normalize(teamName).toLowerCase(),
    ].join("|")
  );
}

function existingSoccerEventCanonicalKey(event) {
  const privateProperties = event.extendedProperties?.private || {};
  const routeId = privateProperties.voloProgramRouteId;
  const startTimestamp = Date.parse(event.start?.dateTime || "");
  if (!routeId || !Number.isFinite(startTimestamp)) return "";

  const teamName = normalize((event.summary || "Soccer").replace(/^Soccer\\s*[—-]\\s*/i, ""));
  return canonicalSoccerGameKey({ routeId, startTimestamp, teamName });
}

`;
  if (!source.includes(marker)) throw new Error("Could not locate soccer event body.");
  source = source.replace(marker, helpers + marker);
}

const oldExistingMap = `  const byGameKey = new Map();

  for (const event of existing) {
    const gameKey = event.extendedProperties?.private?.voloGameKey;
    if (gameKey && !byGameKey.has(gameKey)) byGameKey.set(gameKey, event);
  }

  const presentGameKeys = new Set(games.map((game) => game.gameKey));`;
const canonicalExistingMap = `  const byGameKey = new Map();
  const duplicateEvents = [];
  const duplicateEventIds = new Set();

  for (const event of existing) {
    const storedGameKey = event.extendedProperties?.private?.voloGameKey || "";
    const canonicalGameKey = existingSoccerEventCanonicalKey(event);
    const keys = [...new Set([canonicalGameKey, storedGameKey].filter(Boolean))];

    let duplicate = false;
    for (const key of keys) {
      const selected = byGameKey.get(key);
      if (selected && selected.id !== event.id) {
        duplicate = true;
        break;
      }
    }

    if (duplicate) {
      duplicateEvents.push(event);
      duplicateEventIds.add(event.id);
      continue;
    }

    for (const key of keys) byGameKey.set(key, event);
  }

  const presentGameKeys = new Set(games.map((game) => game.gameKey));`;
if (!source.includes("const duplicateEventIds = new Set();")) {
  if (!source.includes(oldExistingMap)) {
    throw new Error("Could not locate the existing soccer-event map.");
  }
  source = source.replace(oldExistingMap, canonicalExistingMap);
}

const actionsMarker = `  const actions = [];

  for (const game of games) {`;
const duplicateCleanup = `  const actions = [];

  for (const event of duplicateEvents) {
    const startTimestamp = Date.parse(event.start?.dateTime || "");
    const game = {
      gameKey: existingSoccerEventCanonicalKey(event),
      routeId: event.extendedProperties?.private?.voloProgramRouteId || "",
      teamName: normalize((event.summary || "Soccer").replace(/^Soccer\\s*[—-]\\s*/i, "")) || "Soccer",
      location: event.location || "",
      startTimestamp: Number.isFinite(startTimestamp) ? startTimestamp : Date.now(),
    };
    actions.push({ type: "delete", reason: "duplicate", game, eventId: event.id });
    if (!DRY_RUN) {
      await calendarRequest(calendarUrl(\`/events/\${encodeURIComponent(event.id)}\`), {
        method: "DELETE",
      });
    }
  }

  for (const game of games) {`;
if (!source.includes('reason: "duplicate"')) {
  if (!source.includes(actionsMarker)) {
    throw new Error("Could not locate soccer action initialization.");
  }
  source = source.replace(actionsMarker, duplicateCleanup);
}

const oldMissingIdentity = `    const gameKey = privateProperties.voloGameKey;
    const routeId = privateProperties.voloProgramRouteId;
    if (!gameKey || presentGameKeys.has(gameKey) || !routeId) continue;`;
const canonicalMissingIdentity = `    if (duplicateEventIds.has(event.id)) continue;
    const storedGameKey = privateProperties.voloGameKey;
    const canonicalGameKey = existingSoccerEventCanonicalKey(event);
    const gameKey = canonicalGameKey || storedGameKey;
    const routeId = privateProperties.voloProgramRouteId;
    if (!gameKey || presentGameKeys.has(gameKey) || !routeId) continue;`;
if (!source.includes("if (duplicateEventIds.has(event.id)) continue;")) {
  if (!source.includes(oldMissingIdentity)) {
    throw new Error("Could not locate soccer missing-event identity logic.");
  }
  source = source.replace(oldMissingIdentity, canonicalMissingIdentity);
}

await writeFile(path, source, "utf8");
console.log(
  "Restricted soccer calendar sync to teamId-scoped operations, canonicalized event identity, and removed exact managed duplicates."
);
