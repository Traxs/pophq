import { OutputFormat, type BundlingOptions } from "aws-cdk-lib/aws-lambda-nodejs";

/**
 * One bundling setup for every function. The banner matters: the bundles are ES modules, but
 * parts of the AWS SDK still call `require` at load time, and without the shim the function
 * dies on its first invocation with "Dynamic require of node:https is not supported".
 */
export const NODE_BUNDLING: BundlingOptions = {
  format: OutputFormat.ESM,
  target: "node24",
  minify: true,
  sourceMap: true,
  mainFields: ["module", "main"],
  // Bundle the AWS SDK too, so the deployed version matches the tested one.
  externalModules: [],
  banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
};
