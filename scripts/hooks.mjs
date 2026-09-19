#!/usr/bin/env node
// Runs per-package checks for git hooks.
//   pre-commit: lint, typecheck and unit tests of packages with staged changes
//   pre-push:   full unit suite of every package
// Packages opt in by defining the scripts; missing scripts are skipped.
import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = ["api", "web", "infra", "agent/hermes-skill"];
// Integration tests need Docker and run in CI; hooks stay fast.
const stage = process.argv[2];

const present = PACKAGES.filter((p) => existsSync(join(p, "package.json")));
if (present.length === 0) {
  console.log(`[${stage}] no packages yet, nothing to run`);
  process.exit(0);
}

// Cheap repo-wide guard: an import that only resolves through the shared node_modules
// passes locally and breaks in CI.
const deps = spawnSync("node", ["scripts/check-deps.mjs"], { stdio: "inherit" });
if (deps.status !== 0) process.exit(deps.status ?? 1);

let targets = present;
let scripts = ["test:unit"];
if (stage === "pre-commit") {
  const staged = execSync("git diff --cached --name-only", { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  targets = present.filter((p) => staged.some((f) => f.startsWith(`${p}/`)));
  scripts = ["lint", "typecheck", "test:unit"];
}

for (const pkg of targets) {
  for (const script of scripts) {
    const res = spawnSync("npm", ["run", "--if-present", script], {
      cwd: pkg,
      stdio: "inherit",
    });
    if (res.status !== 0) {
      console.error(`[${stage}] ${pkg}: "${script}" failed`);
      process.exit(res.status ?? 1);
    }
  }
}
