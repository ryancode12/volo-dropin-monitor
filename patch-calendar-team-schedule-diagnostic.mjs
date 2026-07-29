await import("./patch-calendar-soccer-route-discovery.mjs");
await import("./patch-calendar-team-schedule-game-values.mjs");
import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-operation-diagnostic.mjs";
let source = await readFile(path, "utf8");

const relevantLine = `    const relevant = diagnostic.operations.filter(isRelevantOperation);`;
const teamScheduleInsert = `    const teamScheduleRecords = diagnostic.operations.filter((item) =>
      /^TeamSchedule$/i.test(item.operationName)
    );
`;

if (!source.includes("const teamScheduleRecords =")) {
  if (!source.includes(relevantLine)) {
    throw new Error("Could not locate the GraphQL relevant-operation line.");
  }
  source = source.replace(relevantLine, `${teamScheduleInsert}${relevantLine}`);
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

if (!source.includes("Soccer diagnostic version: route-context-v3.")) {
  const loginMarker = `      "Volo login: OK.",`;
  if (!source.includes(loginMarker)) {
    throw new Error("Could not locate the Volo login notification line.");
  }
  source = source.replace(
    loginMarker,
    `${loginMarker}\n      "Soccer diagnostic version: route-context-v3.",`
  );
}

source = source.replace("Schedule-related controls:", "Soccer/team schedule-related controls:");
source = source.replace("Relevant schema examples:", "TeamSchedule response structure:");

await writeFile(path, source, "utf8");
console.log("Applied resilient TeamSchedule-focused diagnostic patch v3.");
