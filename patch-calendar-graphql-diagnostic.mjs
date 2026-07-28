import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-diagnostic.mjs";
let source = await readFile(path, "utf8");

const helperMarker = "async function loginAndInspectDashboard() {";
if (!source.includes("function collectGraphqlRegistrationShapes(")) {
  if (!source.includes(helperMarker)) {
    throw new Error("Could not locate dashboard inspection function.");
  }

  const helper = `function collectGraphqlRegistrationShapes(
  value,
  operationName,
  output,
  path = "data",
  depth = 0
) {
  if (depth > 10 || value == null) return;

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 300)) {
      collectGraphqlRegistrationShapes(item, operationName, output, path + "[]", depth + 1);
    }
    return;
  }

  if (typeof value !== "object") return;

  const keys = Object.keys(value);
  const keyText = keys.join(" ");
  const hasUserScope =
    /registration|registered|participant|attendee|roster|signup|sign_up|reservation|booking|enrollment|enrolled|order|purchase|member|user/i.test(
      keyText
    );
  const hasEventScope =
    /program|game|pickup|drop.?in|sport|schedule|start|date|venue|location|team/i.test(keyText);

  if (hasUserScope && hasEventScope) {
    const record = {
      operationName: operationName || "unnamed",
      path,
      keys: keys.slice(0, 30),
    };
    const identity = record.operationName + "|" + record.path + "|" + record.keys.join(",");
    if (!output.some((item) => item.identity === identity)) {
      output.push({ identity, ...record });
    }
  }

  for (const key of keys.slice(0, 120)) {
    collectGraphqlRegistrationShapes(
      value[key],
      operationName,
      output,
      path + "." + key,
      depth + 1
    );
  }
}

`;

  source = source.replace(helperMarker, helper + helperMarker);
}

const collectionMarker = `  const apiResponses = [];
  const jsonEventCandidates = [];
  const snapshots = [];`;
if (!source.includes("const graphqlOperations = [];")) {
  if (!source.includes(collectionMarker)) {
    throw new Error("Could not locate dashboard diagnostic collections.");
  }
  source = source.replace(
    collectionMarker,
    `${collectionMarker}
  const graphqlOperations = [];
  const graphqlRegistrationShapes = [];`
  );
}

const parseMarker = `        const topLevelKeys =`;
if (!source.includes("collectGraphqlRegistrationShapes(parsed")) {
  if (!source.includes(parseMarker)) {
    throw new Error("Could not locate parsed GraphQL response handling.");
  }

  const requestInspection = `        let operationName = "unnamed";
        let variableKeys = [];
        try {
          const postData = response.request().postData();
          if (postData) {
            const payload = JSON.parse(postData);
            const selected = Array.isArray(payload) ? payload[0] : payload;
            operationName = normalizeText(selected?.operationName) || "unnamed";
            variableKeys =
              selected?.variables && typeof selected.variables === "object"
                ? Object.keys(selected.variables).slice(0, 30)
                : [];
          }
        } catch {
          // Some GraphQL requests do not expose a JSON request body.
        }

        const operationIdentity = operationName + "|" + variableKeys.join(",");
        if (!graphqlOperations.some((item) => item.identity === operationIdentity)) {
          graphqlOperations.push({
            identity: operationIdentity,
            operationName,
            variableKeys,
          });
        }

        collectGraphqlRegistrationShapes(
          parsed,
          operationName,
          graphqlRegistrationShapes
        );

`;

  source = source.replace(parseMarker, requestInspection + parseMarker);
}

const returnMarker = `      apiResponses,
      jsonEventCandidates: jsonEventCandidates.slice(0, 50),`;
if (!source.includes("graphqlRegistrationShapes: graphqlRegistrationShapes.slice")) {
  if (!source.includes(returnMarker)) {
    throw new Error("Could not locate dashboard diagnostic return fields.");
  }
  source = source.replace(
    returnMarker,
    `      apiResponses,
      graphqlOperations: graphqlOperations.slice(0, 50),
      graphqlRegistrationShapes: graphqlRegistrationShapes.slice(0, 100),
      jsonEventCandidates: jsonEventCandidates.slice(0, 50),`
  );
}

const likelyMarker = `    const likelyDailyRegistrations = futureCandidates.filter(isLikelyDailyRegistration);`;
if (!source.includes("const registrationShapeExamples =")) {
  if (!source.includes(likelyMarker)) {
    throw new Error("Could not locate targeted registration candidate calculation.");
  }
  source = source.replace(
    likelyMarker,
    `${likelyMarker}
    const operationNames = dashboard.graphqlOperations
      .map((item) => item.operationName)
      .filter(Boolean);
    const registrationShapeExamples = dashboard.graphqlRegistrationShapes
      .slice(0, 8)
      .map(
        (item, index) =>
          \`${"${index + 1}. ${item.operationName} -> ${item.path}\\nkeys: ${item.keys.join(\", \")}"}\`
      )
      .join("\\n\\n");`
  );
}

const messageMarker = `      \`Likely upcoming daily registrations: \${likelyDailyRegistrations.length}.\`,
      examples ? \`Registration evidence examples:\\n\${examples}\` : "No future candidates were found.",`;
if (!source.includes("GraphQL operations observed:")) {
  if (!source.includes(messageMarker)) {
    throw new Error("Could not locate diagnostic notification fields.");
  }
  source = source.replace(
    messageMarker,
    `      \`Likely upcoming daily registrations: \${likelyDailyRegistrations.length}.\`,
      \`GraphQL operations observed: \${[...new Set(operationNames)].join(", ") || "none"}.\`,
      \`User-registration object shapes: \${dashboard.graphqlRegistrationShapes.length}.\`,
      registrationShapeExamples
        ? \`Registration object paths:\\n\${registrationShapeExamples}\`
        : examples
          ? \`Candidate examples:\\n\${examples}\`
          : "No user-registration object shapes were found.",`
  );
}

const consoleMarker = `          likelyDailyRegistrationCount: likelyDailyRegistrations.length,
          futureCandidateEvidence: futureCandidates.slice(0, 20).map(publicEvidence),`;
if (!source.includes("graphqlRegistrationShapeCount:")) {
  if (!source.includes(consoleMarker)) {
    throw new Error("Could not locate diagnostic console summary.");
  }
  source = source.replace(
    consoleMarker,
    `          likelyDailyRegistrationCount: likelyDailyRegistrations.length,
          graphqlOperationCount: dashboard.graphqlOperations.length,
          graphqlRegistrationShapeCount: dashboard.graphqlRegistrationShapes.length,
          graphqlOperations: dashboard.graphqlOperations,
          graphqlRegistrationShapes: dashboard.graphqlRegistrationShapes,
          futureCandidateEvidence: futureCandidates.slice(0, 20).map(publicEvidence),`
  );
}

await writeFile(path, source, "utf8");
console.log("Applied Volo GraphQL operation and registration-path diagnostic.");
