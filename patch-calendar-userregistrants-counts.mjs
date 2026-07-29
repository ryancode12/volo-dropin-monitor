import { readFile, writeFile } from "node:fs/promises";

const path = "volo-calendar-diagnostic.mjs";
let source = await readFile(path, "utf8");

const nonEmptyArrayCheck = `    if (value.length > 0 && !output.some((item) => item.path === arrayPath)) {
      output.push({
        path: arrayPath,
        typename: "Array",
        keys: [],
      });
    }`;

const allArrayCheck = `    if (!output.some((item) => item.path === arrayPath)) {
      output.push({
        path: arrayPath,
        typename: "Array",
        keys: [],
        length: value.length,
      });
    }`;

if (!source.includes("length: value.length")) {
  if (!source.includes(nonEmptyArrayCheck)) {
    throw new Error("Could not locate getUserRegistrants array-tree handling.");
  }
  source = source.replace(nonEmptyArrayCheck, allArrayCheck);
}

const examplesMarker = `    const userRegistrantTreeExamples = dashboard.userRegistrantTree
      .filter((item) =>`;

if (!source.includes("const leagueRegistrantCount =")) {
  if (!source.includes(examplesMarker)) {
    throw new Error("Could not locate getUserRegistrants tree example calculation.");
  }

  const counts = `    const leagueRegistrantCount =
      dashboard.userRegistrantTree.find(
        (item) => item.path === "data.data.registrants[]" && item.typename === "Array"
      )?.length ?? 0;
    const rentalRegistrantCount =
      dashboard.userRegistrantTree.find(
        (item) => item.path === "data.data.rental_registrants[]" && item.typename === "Array"
      )?.length ?? 0;

`;

  source = source.replace(examplesMarker, counts + examplesMarker);
}

const notificationMarker = `      \`getUserRegistrants response nodes: \${dashboard.userRegistrantTree.length}.\`,
      userRegistrantTreeExamples`;

if (!source.includes("League/team registrant records:")) {
  if (!source.includes(notificationMarker)) {
    throw new Error("Could not locate getUserRegistrants notification summary.");
  }

  source = source.replace(
    notificationMarker,
    `      \`getUserRegistrants response nodes: \${dashboard.userRegistrantTree.length}.\`,
      \`League/team registrant records: \${leagueRegistrantCount}.\`,
      \`Rental/daily registrant records: \${rentalRegistrantCount}.\`,
      userRegistrantTreeExamples`
  );
}

const consoleMarker = `          userRegistrantTree: dashboard.userRegistrantTree,`;

if (!source.includes("leagueRegistrantCount,")) {
  if (!source.includes(consoleMarker)) {
    throw new Error("Could not locate getUserRegistrants console summary.");
  }

  source = source.replace(
    consoleMarker,
    `          leagueRegistrantCount,
          rentalRegistrantCount,
          userRegistrantTree: dashboard.userRegistrantTree,`
  );
}

await writeFile(path, source, "utf8");
console.log("Applied getUserRegistrants league/rental array-count diagnostic.");
