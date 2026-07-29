import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-rsvp-diagnostic.mjs";
let source = await readFile(path, "utf8");

const schemaMarker = `    const relevantSchema = diagnostic.schema
      .filter((item) =>
        /rsvp|drop|pickup|game|program|event|start|date|venue|location|team/i.test(
          \`${"${item.path} ${item.typename} ${item.keys.join(\" \")}"}\`
        )
      )
      .slice(0, 12);`;

if (!source.includes("const schemaNotificationLines =")) {
  if (!source.includes(schemaMarker)) {
    throw new Error("Could not locate the RSVP schema summary section.");
  }

  const expanded = `${schemaMarker}

    const schemaNotificationLines = (relevantSchema.length
      ? relevantSchema
      : diagnostic.schema.slice(0, 16)
    )
      .slice(0, 16)
      .map(
        (item, index) =>
          \`${"${index + 1}. ${item.path} [${item.typename}]\\nkeys: ${item.keys.join(\", \") || `(array length ${item.length ?? 0})`}"}\`
      );`;

  source = source.replace(schemaMarker, expanded);
}

const messageMarker = `      \`Upcoming active RSVP candidates: \${upcoming.length}.\`,
      examples.length
        ? \`Upcoming RSVP examples:\\n\${examples.join("\\n")}\`
        : "No upcoming RSVP event candidates could be extracted.",`;

if (!source.includes("myDropInRsvps variable keys:")) {
  if (!source.includes(messageMarker)) {
    throw new Error("Could not locate the RSVP notification message.");
  }

  const replacement = `      \`Upcoming active RSVP candidates: \${upcoming.length}.\`,
      \`myDropInRsvps variable keys: \${diagnostic.variableKeys.join(", ") || "none"}.\`,
      examples.length
        ? \`Upcoming RSVP examples:\\n\${examples.join("\\n")}\`
        : "No upcoming RSVP event candidates could be extracted.",
      schemaNotificationLines.length
        ? \`myDropInRsvps response structure:\\n\${schemaNotificationLines.join("\\n\\n")}\`
        : "No myDropInRsvps response schema was captured.",`;

  source = source.replace(messageMarker, replacement);
}

await writeFile(path, source, "utf8");
console.log("Applied myDropInRsvps schema notification patch.");
