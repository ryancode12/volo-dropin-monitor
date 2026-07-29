import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-operation-diagnostic.mjs";
let source = await readFile(path, "utf8");

const scheduleOperationPattern =
  "(?:getTeamSchedule|TeamGames|GetLeaguePlayerSchedule|TournamentSchedule|getGame)";

source = source.replace(
  `  const operations = [];
  const controls = [];
  const pending = new Set();`,
  `  const operations = [];
  const controls = [];
  const soccerScheduleDetails = [];
  const pending = new Set();`
);

if (!source.includes("function collectSoccerScheduleRecords(")) {
  const helperMarker = `async function inspectVolo() {`;
  const helpers = `function isSoccerScheduleOperation(operationName) {
  return /^(?:getTeamSchedule|TeamGames|GetLeaguePlayerSchedule|TournamentSchedule|getGame)$/i.test(
    operationName
  );
}

function collectSoccerScheduleRecords(value, output, path = "data", depth = 0) {
  if (depth > 14 || value == null || output.length >= 120) return;

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 80)) {
      collectSoccerScheduleRecords(item, output, path + "[]", depth + 1);
    }
    return;
  }

  if (typeof value !== "object") return;

  const startValue =
    value.start_time ?? value.startTime ?? value.start_date ?? value.startDate ?? value.starts_at;
  const endValue = value.end_time ?? value.endTime ?? value.end_date ?? value.endDate ?? value.ends_at;

  if (startValue != null || endValue != null) {
    const fields = {};
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
      if (
        child == null ||
        typeof child === "string" ||
        typeof child === "number" ||
        typeof child === "boolean"
      ) {
        if (
          /name|title|status|start|end|date|time|field|court|venue|location|address|home|away|opponent|score|sport/i.test(
            key
          )
        ) {
          fields[key] = normalize(child).slice(0, 220);
        }
        continue;
      }

      if (
        typeof child === "object" &&
        /team|venue|facility|location|field|court|sport|league|organization/i.test(key)
      ) {
        const nestedValue =
          child.name ?? child.title ?? child.address ?? child.short_name ?? child.display_name;
        if (nestedValue != null) fields[key + ".name"] = normalize(nestedValue).slice(0, 220);
      }
    }

    output.push({
      path,
      startValue,
      endValue,
      fields,
    });
  }

  for (const [key, child] of Object.entries(value).slice(0, 140)) {
    collectSoccerScheduleRecords(child, output, path + "." + key, depth + 1);
  }
}

`;
  if (!source.includes(helperMarker)) throw new Error("Could not locate Volo inspection function.");
  source = source.replace(helperMarker, helpers + helperMarker);
}

const oldSchemaCapture = `          const schema = [];
          collectSchema(responseItems[index] ?? responseItems[0], schema);`;
const newSchemaCapture = `          const responseItem = responseItems[index] ?? responseItems[0];
          const schema = [];
          collectSchema(responseItem, schema);

          if (isSoccerScheduleOperation(operationName)) {
            const records = [];
            collectSoccerScheduleRecords(responseItem, records);
            soccerScheduleDetails.push({
              operationName,
              variableKeys,
              stage,
              records,
            });
          }`;

if (!source.includes(newSchemaCapture)) {
  if (!source.includes(oldSchemaCapture)) {
    throw new Error("Could not locate GraphQL response schema capture.");
  }
  source = source.replace(oldSchemaCapture, newSchemaCapture);
}

source = source.replace(
  `    return { operations, controls, storageKeys };`,
  `    return { operations, controls, soccerScheduleDetails, storageKeys };`
);

if (!source.includes("function formatSoccerScheduleTime(")) {
  const mainMarker = `async function main() {`;
  const formatters = `function formatSoccerScheduleTime(value) {
  const text = normalize(value);
  if (!text) return "missing";

  let timestamp = Date.parse(text);
  if (/^\\d+(?:\\.\\d+)?$/.test(text)) {
    const number = Number(text);
    timestamp =
      number >= 1_000_000_000_000
        ? number
        : number >= 1_000_000_000
          ? number * 1_000
          : NaN;
  }

  if (!Number.isFinite(timestamp)) return text.slice(0, 120);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatSoccerScheduleFields(fields) {
  return Object.entries(fields || {})
    .slice(0, 8)
    .map(([key, value]) => key + "=" + sanitize(value).slice(0, 120))
    .join(" | ");
}

`;
  if (!source.includes(mainMarker)) throw new Error("Could not locate diagnostic main function.");
  source = source.replace(mainMarker, formatters + mainMarker);
}

const controlFormatterEnd = `      .map((item) => \`${"${item.text || \"(no label)\"}${item.path ? ` -> ${item.path}` : \"\"}"}\`);`;
const expandedSummary = `${controlFormatterEnd}

    const soccerScheduleOperations = diagnostic.operations.filter((item) =>
      /^(?:getTeamSchedule|TeamGames|GetLeaguePlayerSchedule|TournamentSchedule|getGame)$/i.test(
        item.operationName
      )
    );
    const soccerScheduleOperationNames = [
      ...new Set(soccerScheduleOperations.map((item) => item.operationName)),
    ];
    const soccerScheduleVariableKeys = [
      ...new Set(soccerScheduleOperations.flatMap((item) => item.variableKeys)),
    ];

    const soccerScheduleValueLines = diagnostic.soccerScheduleDetails
      .flatMap((detail) =>
        detail.records.map((record, index) => {
          const fields = formatSoccerScheduleFields(record.fields);
          return \`${"${detail.operationName} @ ${detail.stage} | game ${index + 1} | ${formatSoccerScheduleTime(record.startValue)} to ${formatSoccerScheduleTime(record.endValue)}${fields ? ` | ${fields}` : \"\"}"}\`;
        })
      )
      .filter((line, index, array) => array.indexOf(line) === index)
      .slice(0, 24);

    const soccerScheduleSchemaLines = soccerScheduleOperations
      .flatMap((operation) =>
        operation.schema
          .filter((item) =>
            /game|schedule|start|end|date|time|team|opponent|venue|facility|location|field|court|address|league|sport/i.test(
              item.path + " " + item.typename + " " + item.keys.join(" ")
            )
          )
          .map(
            (item) =>
              operation.operationName + " @ " + operation.stage + "\\n" +
              item.path + " [" + item.typename + "] keys: " +
              (item.keys.join(", ") || "(array length " + (item.length ?? 0) + ")")
          )
      )
      .filter((line, index, array) => array.indexOf(line) === index)
      .slice(0, 28);`;

if (!source.includes("const soccerScheduleOperations =")) {
  if (!source.includes(controlFormatterEnd)) {
    throw new Error("Could not locate navigation-control summary.");
  }
  source = source.replace(controlFormatterEnd, expandedSummary);
}

const relevantCountLine = `      \`Relevant operation-stage records: \${relevant.length}.\`,`;
const scheduleCountLines = `${relevantCountLine}
      \`Soccer schedule operation-stage records: \${soccerScheduleOperations.length}.\`,
      \`Soccer schedule operations: \${soccerScheduleOperationNames.join(", ") || "none"}.\`,
      \`Soccer schedule variable keys: \${soccerScheduleVariableKeys.join(", ") || "none"}.\`,`;
if (!source.includes("Soccer schedule operation-stage records:")) {
  if (!source.includes(relevantCountLine)) throw new Error("Could not locate operation count line.");
  source = source.replace(relevantCountLine, scheduleCountLines);
}

const oldSchemaMessage = `      schemaExamples.length
        ? \`Relevant schema examples:\\n\${schemaExamples.join("\\n\\n")}\`
        : "Relevant schema examples: none detected.",`;
const newSchemaMessage = `      soccerScheduleValueLines.length
        ? \`Soccer schedule game values:\\n\${soccerScheduleValueLines.join("\\n")}\`
        : "Soccer schedule game values: none captured.",
      soccerScheduleSchemaLines.length
        ? \`Soccer schedule response structure:\\n\${soccerScheduleSchemaLines.join("\\n\\n")}\`
        : "Soccer schedule response structure: none captured.",`;

if (!source.includes("Soccer schedule game values:")) {
  if (!source.includes(oldSchemaMessage)) {
    throw new Error("Could not locate diagnostic schema message.");
  }
  source = source.replace(oldSchemaMessage, newSchemaMessage);
}

await writeFile(path, source, "utf8");
console.log(
  "Applied current Volo soccer schedule operation and game-value diagnostic patch."
);
