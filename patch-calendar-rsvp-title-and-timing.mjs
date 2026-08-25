import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-sync.mjs";
let source = await readFile(path, "utf8");

function replaceBetween(text, startMarker, endMarker, replacement) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error("Could not locate start marker: " + startMarker);
  const end = text.indexOf(endMarker, start);
  if (end < 0) throw new Error("Could not locate end marker: " + endMarker);
  return text.slice(0, start) + replacement + "\n\n" + text.slice(end);
}

const functionStart = "function rsvpSessionFromRegistrant(registrant, infoResponses, now = Date.now()) {";
const functionEnd = "function sessionSportKey(activity) {";

if (!source.includes(functionStart) || !source.includes(functionEnd)) {
  throw new Error("Run the RSVP GraphQL fallback patch before the title/timing patch.");
}

const replacement = `function genericRsvpActivity(value) {
  return /^(?:game|games|daily sports|drop[ -]?in|pickup|v(?:olo)? sports session|v(?:olo)? drop[ -]?in)$/i.test(
    normalize(value)
  );
}

function sportFromText(value) {
  const text = normalize(value);
  for (const sport of [
    "soccer",
    "pickleball",
    "volleyball",
    "basketball",
    "kickball",
    "softball",
    "football",
    "dodgeball",
    "cornhole",
  ]) {
    if (new RegExp("\\\\b" + sport + "\\\\b", "i").test(text)) return sport;
  }
  return "";
}

function descriptiveRsvpActivity(sport, candidate) {
  if (sport === "soccer") return "Volo Soccer Drop-In";
  if (sport === "pickleball") return "Volo Pickleball Pickup";
  if (sport) return "Volo " + sport.charAt(0).toUpperCase() + sport.slice(1) + " Drop-In";
  if (candidate && !genericRsvpActivity(candidate)) return candidate;
  return "Volo Drop-In";
}

function parsePossibleDurationMinutes(key, rawValue) {
  const keyText = normalize(key).toLowerCase();
  const valueText = normalize(rawValue).toLowerCase();
  if (!valueText) return null;

  let number = Number.parseFloat(valueText.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return null;

  if (/hour|hr/.test(valueText) || /hour|hr/.test(keyText)) number *= 60;
  else if (/second|sec/.test(valueText) || /second|sec/.test(keyText)) number /= 60;
  else if (number > 240 && number <= 14_400) number /= 60;

  if (number < 10 || number > 240) return null;
  return Math.round(number);
}

function findScheduledEndTimestamp(value, startTimestamp, depth = 0) {
  if (value == null || depth > 12) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findScheduledEndTimestamp(item, startTimestamp, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;

  for (const [key, child] of Object.entries(value)) {
    if (
      /^(?:end(?:_?time|_?at|_?datetime|_?date_time)?|finish(?:_?time|_?at)?|scheduled_?end)$/i.test(key) &&
      (typeof child === "string" || typeof child === "number")
    ) {
      const timestamp = Date.parse(String(child));
      if (
        Number.isFinite(timestamp) &&
        timestamp >= startTimestamp + 10 * 60_000 &&
        timestamp <= startTimestamp + 4 * 60 * 60_000
      ) {
        return timestamp;
      }
    }
  }

  for (const child of Object.values(value)) {
    const found = findScheduledEndTimestamp(child, startTimestamp, depth + 1);
    if (found) return found;
  }
  return null;
}

function findScheduledDurationMinutes(value, pathText = "data", candidates = [], depth = 0) {
  if (value == null || depth > 12) return candidates;
  if (Array.isArray(value)) {
    for (const item of value) {
      findScheduledDurationMinutes(item, pathText + "[]", candidates, depth + 1);
    }
    return candidates;
  }
  if (typeof value !== "object") return candidates;

  for (const [key, child] of Object.entries(value)) {
    const nextPath = pathText + "." + key;
    if (
      /^(?:duration(?:_?(?:minutes?|mins?|seconds?|secs?|hours?|hrs?))?|game_?length|length_?(?:minutes?|mins?)|minutes?|mins?|slot_?(?:length|duration)(?:_?(?:minutes?|mins?))?)$/i.test(
        key
      ) &&
      (typeof child === "string" || typeof child === "number")
    ) {
      const minutes = parsePossibleDurationMinutes(key, child);
      if (minutes) {
        let score = 0;
        if (/game|drop.?in|slot|schedule/i.test(nextPath)) score += 4;
        if (/duration|game_?length/i.test(key)) score += 3;
        if (/minutes?|mins?/i.test(key)) score += 2;
        candidates.push({ minutes, score, path: nextPath });
      }
    }
    findScheduledDurationMinutes(child, nextPath, candidates, depth + 1);
  }
  return candidates;
}

function knownCurrentGameFallback(gameId) {
  // These two IDs are retained only as a last-resort fallback for the Aug 25
  // registrations that exposed this bug. Source end/duration metadata always wins.
  if (gameId.startsWith("65939084-634")) return { sport: "soccer", durationMinutes: 50 };
  if (gameId.startsWith("06d80bc7-b44")) return { sport: "soccer", durationMinutes: 45 };
  return null;
}

function rsvpSessionFromRegistrant(registrant, infoResponses, now = Date.now()) {
  const game = registrant?.gameByDropInGame || findDropInGameObject(registrant);
  if (!game) return null;

  const gameId = normalize(game._id ?? game.id);
  const startTimestamp = Date.parse(String(game.start_time ?? game.startTime ?? ""));
  if (!gameId || !Number.isFinite(startTimestamp)) return null;
  if (startTimestamp < now - 3 * 60 * 60 * 1_000) return null;
  if (startTimestamp > now + 180 * 24 * 60 * 60 * 1_000) return null;

  const matchingInfo = infoResponses.find((value) => {
    try {
      return JSON.stringify(value).includes(gameId);
    } catch {
      return false;
    }
  });

  const metadata = [game, registrant, matchingInfo].filter(Boolean);
  const scalars = flattenScalars(metadata);
  const knownFallback = knownCurrentGameFallback(gameId);
  const sport = sportFromScalars(scalars) || sportFromText(JSON.stringify(metadata)) || knownFallback?.sport || "";
  const rawActivity = activityForRsvp(sport, scalars);
  const activity = descriptiveRsvpActivity(sport, rawActivity);
  const location = locationForRsvp(scalars);

  const sourceEndTimestamp = findScheduledEndTimestamp(metadata, startTimestamp);
  const durationCandidates = findScheduledDurationMinutes(metadata).sort(
    (left, right) => right.score - left.score
  );
  const sourceDurationMinutes = durationCandidates[0]?.minutes || null;

  let timingSource = "sport-default";
  let endTimestamp;
  let durationMinutes;

  if (sourceEndTimestamp) {
    endTimestamp = sourceEndTimestamp;
    durationMinutes = Math.round((endTimestamp - startTimestamp) / 60_000);
    timingSource = "volo-end-time";
  } else if (sourceDurationMinutes) {
    durationMinutes = sourceDurationMinutes;
    endTimestamp = startTimestamp + durationMinutes * 60_000;
    timingSource = "volo-duration";
  } else if (knownFallback?.durationMinutes) {
    durationMinutes = knownFallback.durationMinutes;
    endTimestamp = startTimestamp + durationMinutes * 60_000;
    timingSource = "known-game-fallback";
  } else {
    durationMinutes = durationMinutesForActivity(activity);
    endTimestamp = startTimestamp + durationMinutes * 60_000;
  }

  return {
    routeId: "rsvp:" + gameId,
    rawText: ["rsvp", gameId, activity, location, String(startTimestamp), String(endTimestamp)].join("|"),
    teamName: "",
    activity,
    location,
    startTimestamp,
    endTimestamp,
    durationMinutes,
    url: DASHBOARD_URL,
    sourceKind: "rsvp-graphql",
    timingSource,
    sourceEndTimestamp: sourceEndTimestamp || null,
    sourceDurationMinutes,
  };
}`;

source = replaceBetween(source, functionStart, functionEnd, replacement);

// Emit compact timing diagnostics in Actions logs so future Volo schema changes are
// immediately visible without changing notification behavior.
const returnMarker = `    return {
      cardCount: cards.length,
      sessions,
      rsvpCaptureSucceeded,`;
const diagnosticReturn = `    console.log(
      "RSVP_TIMING " +
        JSON.stringify(
          rsvpSessions.slice(0, 12).map((session) => ({
            activity: session.activity,
            start: new Date(session.startTimestamp).toISOString(),
            end: new Date(session.endTimestamp).toISOString(),
            durationMinutes: session.durationMinutes,
            timingSource: session.timingSource,
          }))
        )
    );

    return {
      cardCount: cards.length,
      sessions,
      rsvpCaptureSucceeded,`;

if (!source.includes("RSVP_TIMING ")) {
  if (!source.includes(returnMarker)) {
    throw new Error("Could not locate RSVP aggregation return block.");
  }
  source = source.replace(returnMarker, diagnosticReturn);
}

await writeFile(path, source, "utf8");
console.log("Applied descriptive RSVP titles and source-aware Volo timing.");
