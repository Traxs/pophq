#!/usr/bin/env node
// Runs the API and the web app together with hot reload. Start the stack first: npm run dev:up
import { spawn } from "node:child_process";

const procs = [
  spawn("npm", ["run", "dev", "-w", "api"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev", "-w", "web"], { stdio: "inherit" }),
];

const stop = () => {
  for (const p of procs) p.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", (code) => code && code !== 0 && stop());
