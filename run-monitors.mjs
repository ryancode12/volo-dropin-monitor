import { spawn } from "node:child_process";

const commands = [
  ["node", ["patch-monitor.mjs"]],
  ["node", ["patch-monitor-resilience.mjs"]],
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
    console.error(`${label} failed with exit code ${exitCode}. Continuing with the other monitor.`);
  }
}

if (failed) process.exitCode = 1;
