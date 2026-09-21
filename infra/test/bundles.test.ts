import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { App } from "aws-cdk-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { AppStack } from "../lib/app-stack.js";
import { PROD } from "../lib/config.js";

/**
 * Loads every bundled function the way Lambda does. A bundle that only fails at startup
 * (for example an ES module that still calls `require`) passes every other test but dies on
 * the first invocation in production; this catches that before a deploy.
 */
describe("Lambda bundles", () => {
  let assets: string[] = [];

  beforeAll(() => {
    // A fresh directory each run: leftovers from an earlier build would be tested as if current.
    const app = new App({ outdir: mkdtempSync(join(tmpdir(), "pophq-bundles-")) });
    new AppStack(app, "BundleTest", { env: PROD, webAssetPath: "assets/login" });
    const assembly = app.synth();
    assets = readdirSync(assembly.directory)
      .filter((name) => name.startsWith("asset.") && existsSync(join(assembly.directory, name, "index.mjs")))
      .map((name) => join(assembly.directory, name, "index.mjs"));
  });

  it("bundles every function", () => {
    expect(assets.length).toBeGreaterThanOrEqual(3); // API, history writer, kill switch
  });

  it("each bundle loads and exports a handler", () => {
    // Loaded in a plain Node process: Vitest's module loader provides `require` in ES modules,
    // which hides exactly the failure this test is here to catch.
    const env = {
      ...process.env,
      TABLE_NAME: "test-table",
      HISTORY_TABLE_NAME: "test-history",
      EVIDENCE_BUCKET_NAME: "test-evidence",
      OIDC_ISSUER: "https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_test",
      KILL_SWITCH_PARAMETER: "/pophq/kill-switch",
      USER_POOL_ID: "eu-central-1_test",
      AWS_REGION: "eu-central-1",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
    };
    for (const asset of assets) {
      const script = `const m = await import(${JSON.stringify(pathToFileURL(asset).href)});
        if (typeof m.handler !== "function") { console.error("no handler export"); process.exit(2); }`;
      expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, stdio: "pipe" }), asset).not.toThrow();
    }
  }, 60_000);
});
