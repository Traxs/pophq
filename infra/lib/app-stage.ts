import { Aspects, Stage, type CfnOutput, type StageProps } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import type { Construct } from "constructs";
import { AppStack } from "./app-stack.js";

export interface AppStageProps extends StageProps {
  webAssetPath: string;
}

/** One deployable copy of POP HQ. There is only production (spec: Platform). */
export class AppStage extends Stage {
  readonly app: AppStack;
  readonly url: CfnOutput;

  constructor(scope: Construct, id: string, props: AppStageProps) {
    super(scope, id, props);
    this.app = new AppStack(this, "App", { stackName: "PopHq", webAssetPath: props.webAssetPath });
    this.url = this.app.url;
    // Aspects on the app don't cross Stage boundaries, so the stage runs its own checks.
    Aspects.of(this).add(new AwsSolutionsChecks());
  }
}
