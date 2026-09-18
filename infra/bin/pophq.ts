import { existsSync } from "node:fs";
import { App, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { PROD, WEB_DIST } from "../lib/config.js";
import { PipelineStack } from "../lib/pipeline-stack.js";

if (!existsSync(WEB_DIST)) {
  throw new Error("web/dist is missing. Run `npm run build` first.");
}

const app = new App();
new PipelineStack(app, "PopHqPipeline", { env: PROD, webAssetPath: WEB_DIST });
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
app.synth();
