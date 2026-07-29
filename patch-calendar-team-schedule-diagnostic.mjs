import "./patch-calendar-soccer-route-discovery.mjs";
import "./patch-calendar-team-schedule-game-values.mjs";
import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-operation-diagnostic.mjs";
let source = await readFile(path, "utf8");

const relevantMarker = `    const relevant = diagnostic.operations.filter(isRelevantOperation);
    const schemaExamples = relevant
      .flatMap((operation) =>
        relevantSchemaLines(operation).map(
          (line) => \`${"${operation.operationName} @ ${operation.stage}\n${line}"}\`
        )
      )
      .slice(0, 8);`;

const targetedBlock = `    const teamScheduleRecords = diagnostic.operations.filter((item) =>
      /^TeamSchedule$/i.test(item.operationName)
    );
    const relevant = diagnostic.operations.filter(isRelevantOperation);
    const schemaExamples = teamScheduleRecords
      .flatMap((operation) =>
        operation.schema.slice(0, 40).map(
          (item) =>
            \`${"${operation.operationName} @ ${operation.stage}\n${item.path} [${item.typename}] keys: ${item.keys.join(\", \") || `(array length ${item.length ?? 0})`}"}\`
        )
      )
      .filter((line, index, array) => array.indexOf(line) === index)
      .slice(0, 24);`;

if (!source.includes("const teamScheduleRecords =")) {
  if (!source.includes(relevantMarker)) {
    throw new Error("Could not locate the GraphQL schema-summary block.");
  }
  source = source.replace(relevantMarker, targetedBlock);
}

const controlsMarker = `    const controlExamples = [...new Map(
      diagnostic.controls.map((item) => [\`${"${item.text}|${item.path}"}\`, item])
    ).values()]
      .slice(0, 10)
      .map((item) => \`${"${item.text || \"(no label)\"}${item.path ? ` -> ${item.path}` : \"\"}"}\`);`;

const targetedControls = `    const uniqueControls = [...new Map(
      diagnostic.controls.map((item) => [\`${"${item.text}|${item.path}"}\`, item])
    ).values()];
    const controlExamples = [
      ...uniqueControls.filter((item) => /soccer/i.test(item.text || "")),
      ...uniqueControls.filter(
        (item) => !/soccer/i.test(item.text || "") && /\\/app\\/(?:team|league|program)\\//i.test(item.path || "")
      ),
    ]
      .slice(0, 12)
      .map((item) => \`${"${item.text || \"(no label)\"}${item.path ? ` -> ${item.path}` : \"\"}"}\`);`;

if (!source.includes("const uniqueControls =")) {
  if (!source.includes(controlsMarker)) {
    throw new Error("Could not locate the GraphQL control-summary block.");
  }
  source = source.replace(controlsMarker, targetedControls);
}

const messageMarker = `      \`Relevant operation-stage records: \${relevant.length}.\`,`;
const messageReplacement = `      \`Relevant operation-stage records: \${relevant.length}.\`,
      \`TeamSchedule operation-stage records: \${teamScheduleRecords.length}.\`,
      \`TeamSchedule variable keys: \${[
        ...new Set(teamScheduleRecords.flatMap((item) => item.variableKeys)),
      ].join(", ") || "none"}.\`,`;

if (!source.includes("TeamSchedule operation-stage records:")) {
  if (!source.includes(messageMarker)) {
    throw new Error("Could not locate the GraphQL notification counts.");
  }
  source = source.replace(messageMarker, messageReplacement);
}

source = source.replace("Schedule-related controls:", "Soccer/team schedule-related controls:");
source = source.replace("Relevant schema examples:", "TeamSchedule response structure:");

await writeFile(path, source, "utf8");
console.log("Applied TeamSchedule-focused GraphQL diagnostic patch.");
