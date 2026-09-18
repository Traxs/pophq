import { Stack, type StackProps } from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import { PipelineType } from "aws-cdk-lib/aws-codepipeline";
import * as codestarconnections from "aws-cdk-lib/aws-codestarconnections";
import * as pipelines from "aws-cdk-lib/pipelines";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";
import { AppStage } from "./app-stage.js";
import { REPO } from "./config.js";

export interface PipelineStackProps extends StackProps {
  webAssetPath: string;
}

/**
 * Push to main -> checks -> synth -> self-update -> deploy -> smoke test.
 * The GitHub connection is created PENDING and approved once in the AWS console (P1.5).
 */
export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const connection = new codestarconnections.CfnConnection(this, "GitHub", {
      connectionName: "pophq-github",
      providerType: "GitHub",
    });

    const source = pipelines.CodePipelineSource.connection(REPO.name, REPO.branch, {
      connectionArn: connection.attrConnectionArn,
      triggerOnPush: true,
    });

    const pipeline = new pipelines.CodePipeline(this, "Pipeline", {
      pipelineName: "pophq",
      pipelineType: PipelineType.V2,
      crossAccountKeys: false, // single account; avoids a KMS key
      selfMutation: true,
      publishAssetsInParallel: false,
      codeBuildDefaults: {
        buildEnvironment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          computeType: codebuild.ComputeType.SMALL,
        },
        partialBuildSpec: codebuild.BuildSpec.fromObject({
          phases: { install: { "runtime-versions": { nodejs: 22 } } },
        }),
      },
      synth: new pipelines.ShellStep("Synth", {
        input: source,
        installCommands: ["npm ci"],
        commands: [
          "npm run lint",
          "npm run typecheck",
          "npm run test:unit",
          "npm run build",
          "npm run synth -w infra",
        ],
        primaryOutputDirectory: "infra/cdk.out",
      }),
    });

    const prod = new AppStage(this, "Prod", { env: props.env ?? {}, webAssetPath: props.webAssetPath });
    pipeline.addStage(prod, {
      post: [
        new pipelines.ShellStep("SmokeTest", {
          envFromCfnOutputs: { URL: prod.url },
          commands: [
            'curl -fsS --retry 5 --retry-all-errors "$URL/v1/health"',
            'curl -fsS -o /dev/null "$URL/"',
            'curl -fsS "$URL/config.json"',
            // Protected routes must refuse anonymous calls.
            'test "$(curl -s -o /dev/null -w "%{http_code}" "$URL/v1/me")" = "401"',
          ],
        }),
      ],
    });

    pipeline.buildPipeline();
    NagSuppressions.addStackSuppressions(this, [
      { id: "AwsSolutions-IAM5", reason: "CDK Pipelines roles: wildcards are scoped to this pipeline's artifacts and bootstrap roles." },
      { id: "AwsSolutions-S1", reason: "Pipeline artifact bucket; access logs add cost without value here." },
      { id: "AwsSolutions-CB4", reason: "Build projects use the AWS managed key for artifacts; no customer KMS key (cost)." },
    ]);
  }
}
