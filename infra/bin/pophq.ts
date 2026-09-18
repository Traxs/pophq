import { existsSync } from "node:fs";
import { App, Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { PROD, WEB_DIST } from "../lib/config.js";
import { PipelineStack } from "../lib/pipeline-stack.js";

if (!existsSync(WEB_DIST)) {
  throw new Error("web/dist is missing. Run `npm run build` first.");
}

const app = new App();
new PipelineStack(app, "PopHqPipeline", { env: PROD, webAssetPath: WEB_DIST });
Aspects.of(app).add(new AwsSolutionsChecks());
app.synth();
