import { spawn } from "node:child_process";

const commands = [
  ["node", ["patch-monitor.mjs"]],
  ["node", ["patch-monitor-current-volo-format.mjs"]],
  // Replace the availability function before the authenticated-session patch
  // inserts login helpers immediately ahead of scrapeMatches(). This keeps the
  // patches independent and avoids deleting loginToVolo() by accident.
  ["node", ["patch-monitor-authoritative-game-inventory.mjs"]],
  ["node", ["patch-monitor-authenticated-session.mjs"]],
  ["node", ["patch-monitor-resilience.mjs"]],
  ["node", ["validate-composed-monitor.mjs"]],
  ["node", ["--check", "monitor.mjs"]],
  ["node", ["monitor.mjs"]],
];

let failed = false;
for (const [command, args] of commands) {
  const label = [command, ...args].join(" ");
  console.log(`\n=== ${label} ===`);
  const exitCode = await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
      shell: false,
    });
    child.on("error", (error) => {
      console.error(`${label} could not start:`, error);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) console.error(`${label} ended from signal ${signal}`);
      resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) {
    failed = true;
    console.error(`${label} failed with exit code ${exitCode}.`);
    // Never execute the monitor when a runtime patch or composed validation failed.
    break;
  }
}

if (failed) process.exitCode = 1;
