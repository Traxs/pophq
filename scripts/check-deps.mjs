#!/usr/bin/env node
// Every package a file imports must be declared where it can be found at runtime:
//   - code that ships (api/src/**, web/src/**, infra/lib/**, …): a dependency of its workspace
//   - tests, scripts and config: may also use the workspace's or the root's devDependencies
// Node's own modules don't count. Without this check, a package that happens to sit in the
// shared node_modules passes locally and then fails in CI or at runtime on Lambda.
import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, join } from "node:path";

const WORKSPACES = ["api", "web", "infra"];
const CODE = /\.(ts|tsx|mts|js|mjs)$/;
// Bounded on purpose: an unbounded gap between "import" and "from" used to run across whole
// files and match the word "from" inside a comment, reporting a prose phrase as a package.
// No import clause contains a semicolon, so a statement end stops the search.
const IMPORT = /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;

/** Comments are prose, not code: "…different from "any time"" is not an import. */
const withoutComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Only after whitespace or at the start of a line, so "https://…" inside a string survives.
    .replace(/(^|\s)\/\/.*$/gm, "$1");
const builtins = new Set(builtinModules);

/** Tests, scripts and config files never run on AWS, so dev tooling is fine there. */
const isDevFile = (path) =>
  /\.test\.[jt]sx?$/.test(path) ||
  /(^|\/)(test|tests|scripts|dev)\//.test(path) ||
  /(^|\/)server\.ts$/.test(path) ||
  /\.config\.[jt]s$/.test(basename(path));

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return ["node_modules", "dist", "cdk.out", "coverage"].includes(e.name) ? [] : files(path);
    return CODE.test(e.name) ? [path] : [];
  });

/** "@scope/name/sub" -> "@scope/name" */
const packageOf = (spec) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const rootDev = new Set(Object.keys(read("package.json").devDependencies ?? {}));

let problems = 0;
for (const ws of WORKSPACES) {
  const pkg = read(join(ws, "package.json"));
  const deps = new Set(Object.keys(pkg.dependencies ?? {}));
  const devDeps = new Set(Object.keys(pkg.devDependencies ?? {}));
  for (const file of files(ws)) {
    const dev = isDevFile(file);
    for (const match of withoutComments(readFileSync(file, "utf8")).matchAll(IMPORT)) {
      const spec = match[1] ?? match[2];
      if (!spec || spec.startsWith(".") || spec.startsWith("node:")) continue;
      const name = packageOf(spec);
      if (builtins.has(name) || deps.has(name)) continue;
      if (dev && (devDeps.has(name) || rootDev.has(name))) continue;
      const why =
        devDeps.has(name) || rootDev.has(name)
          ? `"${name}" is only a devDependency, but this file ships to AWS`
          : `"${name}" is not declared in ${ws}/package.json`;
      console.error(`${file}: ${why}`);
      problems += 1;
    }
  }
}

if (problems > 0) {
  console.error(`\n${problems} undeclared import(s). Add them with: npm install -w <workspace> --save-prod <package>`);
  process.exit(1);
}
console.info("Dependencies: every imported package is declared where it is needed.");
