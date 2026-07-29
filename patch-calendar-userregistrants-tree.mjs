import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-diagnostic.mjs";
let source = await readFile(path, "utf8");

const helperMarker = "async function loginAndInspectDashboard() {";
if (!source.includes("function collectUserRegistrantTree(")) {
  if (!source.includes(helperMarker)) {
    throw new Error("Could not locate dashboard inspection function.");
  }

  const helper = `function collectUserRegistrantTree(
  value,
  output,
  path = "data",
  depth = 0
) {
  if (depth > 12 || value == null) return;

  if (Array.isArray(value)) {
    const arrayPath = path + "[]";
    if (value.length > 0 && !output.some((item) => item.path === arrayPath)) {
      output.push({
        path: arrayPath,
        typename: "Array",
        keys: [],
      });
    }
    for (const item of value.slice(0, 20)) {
      collectUserRegistrantTree(item, output, arrayPath, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") return;

  const keys = Object.keys(value).slice(0, 40);
  const typename =
    typeof value.__typename === "string" ? normalizeText(value.__typename) : "Object";
  const identity = path + "|" + typename + "|" + keys.join(",");

  if (!output.some((item) => item.identity === identity)) {
    output.push({
      identity,
      path,
      typename,
      keys,
    });
  }

  for (const key of Object.keys(value).slice(0, 120)) {
    collectUserRegistrantTree(value[key], output, path + "." + key, depth + 1);
  }
}

`;

  source = source.replace(helperMarker, helper + helperMarker);
}

const collectionMarker = `  const graphqlOperations = [];
  const graphqlRegistrationShapes = [];`;
if (!source.includes("const userRegistrantTree = [];")) {
  if (!source.includes(collectionMarker)) {
    throw new Error("Could not locate GraphQL diagnostic collections.");
  }
  source = source.replace(
    collectionMarker,
    `${collectionMarker}
  const userRegistrantTree = [];`
  );
}

const collectionCallMarker = `        collectGraphqlRegistrationShapes(
          parsed,
          operationName,
          graphqlRegistrationShapes
        );`;
if (!source.includes("collectUserRegistrantTree(parsed, userRegistrantTree")) {
  if (!source.includes(collectionCallMarker)) {
    throw new Error("Could not locate GraphQL response shape collection.");
  }
  source = source.replace(
    collectionCallMarker,
    `${collectionCallMarker}

        if (/^getUserRegistrants$/i.test(operationName)) {
          collectUserRegistrantTree(parsed, userRegistrantTree);
        }`
  );
}

const returnMarker = `      graphqlOperations: graphqlOperations.slice(0, 50),
      graphqlRegistrationShapes: graphqlRegistrationShapes.slice(0, 100),`;
if (!source.includes("userRegistrantTree: userRegistrantTree.slice")) {
  if (!source.includes(returnMarker)) {
    throw new Error("Could not locate GraphQL diagnostic return fields.");
  }
  source = source.replace(
    returnMarker,
    `${returnMarker}
      userRegistrantTree: userRegistrantTree.slice(0, 200),`
  );
}

const exampleMarker = `    const registrationShapeExamples = dashboard.graphqlRegistrationShapes
      .slice(0, 8)
      .map(
        (item, index) =>
          \`\${index + 1}. \${item.operationName} -> \${item.path}\\nkeys: \${item.keys.join(", ")}\`
      )
      .join("\\n\\n");`;
if (!source.includes("const userRegistrantTreeExamples =")) {
  if (!source.includes(exampleMarker)) {
    throw new Error("Could not locate GraphQL diagnostic example calculation.");
  }

  source = source.replace(
    exampleMarker,
    `${exampleMarker}
    const userRegistrantTreeExamples = dashboard.userRegistrantTree
      .filter((item) =>
        /registrant|registration|user|member|participant|program|drop|pickup|game|schedule|team/i.test(
          item.path + " " + item.keys.join(" ") + " " + item.typename
        )
      )
      .slice(0, 14)
      .map(
        (item, index) =>
          \`\${index + 1}. \${item.path} [\${item.typename}]\\nkeys: \${item.keys.join(", ") || "(array)"}\`
      )
      .join("\\n\\n");`
  );
}

const messageMarker = `      \`User-registration object shapes: \${dashboard.graphqlRegistrationShapes.length}.\`,
      registrationShapeExamples
        ? \`Registration object paths:\\n\${registrationShapeExamples}\`
        : examples
          ? \`Candidate examples:\\n\${examples}\`
          : "No user-registration object shapes were found.",`;
if (!source.includes("getUserRegistrants response nodes:")) {
  if (!source.includes(messageMarker)) {
    throw new Error("Could not locate GraphQL diagnostic notification fields.");
  }

  source = source.replace(
    messageMarker,
    `      \`User-registration object shapes: \${dashboard.graphqlRegistrationShapes.length}.\`,
      \`getUserRegistrants response nodes: \${dashboard.userRegistrantTree.length}.\`,
      userRegistrantTreeExamples
        ? \`getUserRegistrants structure:\\n\${userRegistrantTreeExamples}\`
        : registrationShapeExamples
          ? \`Registration object paths:\\n\${registrationShapeExamples}\`
          : examples
            ? \`Candidate examples:\\n\${examples}\`
            : "No getUserRegistrants response structure was captured.",`
  );
}

const consoleMarker = `          graphqlOperations: dashboard.graphqlOperations,
          graphqlRegistrationShapes: dashboard.graphqlRegistrationShapes,`;
if (!source.includes("userRegistrantTree: dashboard.userRegistrantTree")) {
  if (!source.includes(consoleMarker)) {
    throw new Error("Could not locate GraphQL diagnostic console fields.");
  }
  source = source.replace(
    consoleMarker,
    `${consoleMarker}
          userRegistrantTree: dashboard.userRegistrantTree,`
  );
}

await writeFile(path, source, "utf8");
console.log("Applied getUserRegistrants response-tree diagnostic.");
