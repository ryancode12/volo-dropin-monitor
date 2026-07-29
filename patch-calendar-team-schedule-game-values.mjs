import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-operation-diagnostic.mjs";
let source = await readFile(path, "utf8");

source = source.replace(
  `  const operations = [];
  const controls = [];
  const pending = new Set();`,
  `  const operations = [];
  const controls = [];
  const teamScheduleDetails = [];
  const pending = new Set();`
);

const oldSchema = `          const schema = [];
          collectSchema(responseItems[index] ?? responseItems[0], schema);`;
const newSchema = `          const responseItem = responseItems[index] ?? responseItems[0];
          const schema = [];
          collectSchema(responseItem, schema);
          if (/^TeamSchedule$/i.test(operationName)) {
            const games = responseItem?.data?.teams_by_pk?.leagueByLeague?.games;
            teamScheduleDetails.push({
              stage,
              games: Array.isArray(games)
                ? games.slice(0, 40).map((game) => ({
                    startTime: game?.start_time ?? game?.startTime ?? "",
                    endTime: game?.end_time ?? game?.endTime ?? "",
                  }))
                : [],
            });
          }`;
if (!source.includes(newSchema)) {
  if (!source.includes(oldSchema)) throw new Error("Could not locate GraphQL schema capture.");
  source = source.replace(oldSchema, newSchema);
}

source = source.replace(
  `    return { operations, controls, storageKeys };`,
  `    return { operations, controls, teamScheduleDetails, storageKeys };`
);

if (!source.includes("function formatScheduleTime(")) {
  source = source.replace(
    `async function main() {`,
    `function formatScheduleTime(value) {
  const text = normalize(value);
  if (!text) return "missing";
  let timestamp = Date.parse(text);
  if (/^\\d+$/.test(text)) {
    const number = Number(text);
    timestamp = number >= 1_000_000_000_000 ? number : number >= 1_000_000_000 ? number * 1_000 : NaN;
  }
  if (!Number.isFinite(timestamp)) return text;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

async function main() {`
  );
}

const controlEnd = `      .map((item) => \`${"${item.text || \"(no label)\"}${item.path ? ` -> ${item.path}` : \"\"}"}\`);`;
const controlExpanded = `${controlEnd}

    const teamScheduleValueLines = diagnostic.teamScheduleDetails
      .flatMap((record) => record.games.map(
        (game, index) => \`${"${record.stage} | game ${index + 1} | ${formatScheduleTime(game.startTime)} to ${formatScheduleTime(game.endTime)}"}\`
      ))
      .filter((line, index, array) => array.indexOf(line) === index)
      .slice(0, 16);`;
if (!source.includes("const teamScheduleValueLines =")) {
  if (!source.includes(controlEnd)) throw new Error("Could not locate control formatter.");
  source = source.replace(controlEnd, controlExpanded);
}

const schemaMessage = `      schemaExamples.length
        ? \`Relevant schema examples:\\n\${schemaExamples.join("\\n\\n")}\`
        : "Relevant schema examples: none detected.",`;
const newSchemaMessage = `      teamScheduleValueLines.length
        ? \`TeamSchedule game values:\\n\${teamScheduleValueLines.join("\\n")}\`
        : "TeamSchedule game values: none captured.",
${schemaMessage}`;
if (!source.includes("TeamSchedule game values:")) {
  if (!source.includes(schemaMessage)) throw new Error("Could not locate schema notification.");
  source = source.replace(schemaMessage, newSchemaMessage);
}

await writeFile(path, source, "utf8");
console.log("Applied TeamSchedule game-value capture patch.");
