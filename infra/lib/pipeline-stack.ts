import { Stack, type StackProps } from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import { PipelineType } from "aws-cdk-lib/aws-codepipeline";
import * as codestarconnections from "aws-cdk-lib/aws-codestarconnections";
import * as pipelines from "aws-cdk-lib/pipelines";
import type { Construct } from "constructs";
import { S3_GRANT_ACTIONS, acknowledge, acknowledgeEach } from "./nag.js";
import { AppStage } from "./app-stage.js";
import { REPO } from "./config.js";

export interface PipelineStackProps extends StackProps {
  webAssetPath: string;
  /** The custom domain once it exists (P2.1). */
  site?: { domainName: string; hostedZoneId: string } | undefined;
}

/**
 * Push to main -> checks -> synth -> self-update -> deploy -> smoke test.
 * The GitHub connection is created PENDING and approved once in the AWS console (P1.5).
 */
export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    // Approved against the GitHub App installation on the Traxs organization (which owns the
    // repo). An installation on a personal account can read the repo but sends no push events.
    const connection = new codestarconnections.CfnConnection(this, "GitHubOrg", {
      connectionName: "pophq-github-org",
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
          // Amazon Linux 2023 image; Ubuntu standard:7.0 has no Node 24.
          buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
          computeType: codebuild.ComputeType.SMALL,
        },
        partialBuildSpec: codebuild.BuildSpec.fromObject({
          phases: { install: { "runtime-versions": { nodejs: 24 } } },
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

    const prod = new AppStage(this, "Prod", {
      env: props.env ?? {},
      webAssetPath: props.webAssetPath,
      site: props.site,
    });
    pipeline.addStage(prod, {
      post: [
        new pipelines.ShellStep("SmokeTest", {
          envFromCfnOutputs: { URL: prod.url, DIRECT_API: prod.directApiUrl },
          commands: [
            'curl -fsS --retry 5 --retry-all-errors "$URL/v1/health"',
            'curl -fsS -o /dev/null "$URL/"',
            'curl -fsS "$URL/config.json"',
            // Protected routes must refuse anonymous calls.
            'test "$(curl -s -o /dev/null -w "%{http_code}" "$URL/v1/me")" = "401"',
            // API Gateway is reachable only through CloudFront (API key added by CloudFront).
            'test "$(curl -s -o /dev/null -w "%{http_code}" "${DIRECT_API}v1/health")" = "403"',
          ],
        }),
      ],
    });

    pipeline.buildPipeline();

    const { account, region } = this;
    const projects = ["PipelineBuildSynthCdkBuildProject6BEFA8E6", "PipelineProdSmokeTestEE2CAE0A", "PipelineUpdatePipelineSelfMutationDAA41400"];
    acknowledgeEach(
      this,
      "AwsSolutions-IAM5",
      [
        ...S3_GRANT_ACTIONS,
        "Resource::<PipelineArtifactsBucketAEA9A052.Arn>/*",
        ...projects.flatMap((p) => [
          `Resource::arn:aws:logs:${region}:${account}:log-group:/aws/codebuild/<${p}>:*`,
          `Resource::arn:aws:codebuild:${region}:${account}:report-group/<${p}>-*`,
        ]),
        `Resource::arn:aws:logs:${region}:${account}:log-group:/aws/codebuild/*`,
        `Resource::arn:aws:codebuild:${region}:${account}:report-group/*`,
      ],
      "CDK Pipelines roles: artifact bucket objects and each build project's own logs and reports.",
    );
    acknowledgeEach(
      this,
      "AwsSolutions-IAM5",
      [`Resource::arn:*:iam::${account}:role/*`, "Resource::*"],
      "CDK Pipelines self-mutation and asset publishing: assume only the CDK bootstrap roles (tag condition) and describe stacks.",
    );
    acknowledge(this, {
      "AwsSolutions-S1": "Pipeline artifact bucket; access logs add cost without value here.",
      "AwsSolutions-CB4": "Build projects use the AWS managed key for artifacts; no customer KMS key (cost)."
    });

    // Deploying the certificate to us-east-1 makes CDK Pipelines add a support stack there with a
    // replication bucket for artifacts. It is a separate stack, so the acknowledgements above do
    // not reach it; without these the first synth after buying the domain fails on cdk-nag.
    for (const support of Object.values(pipeline.pipeline.crossRegionSupport)) {
      acknowledge(support.stack, {
        "AwsSolutions-S1": "CDK Pipelines cross-region artifact replica; access logs add cost without value here.",
      });
      // The grant lands on the pipeline's own role, and the replica has a generated physical name,
      // so the finding carries the literal bucket ARN. The name is a token until resolved here.
      const replica: unknown = this.resolve(support.replicationBucket.bucketName);
      acknowledgeEach(
        this,
        "AwsSolutions-IAM5",
        [`Resource::arn:aws:s3:::${String(replica)}/*`],
        "CDK Pipelines replication bucket: the pipeline role reads and writes artifact objects in it.",
      );
    }
  }
}
