import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Aspects, Stack } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { beforeAll, describe, expect, it } from "vitest";
import { AppStack } from "../lib/app-stack.js";
import { AppStage } from "../lib/app-stage.js";
import { PROD } from "../lib/config.js";
import { PipelineStack } from "../lib/pipeline-stack.js";

function fakeWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "pophq-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>POP HQ</title>");
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
  return dir;
}

const nagErrors = (stack: Stack) =>
  Annotations.fromStack(stack).findError("*", Match.stringLikeRegexp("AwsSolutions-.*"));

describe("AppStack", () => {
  let stack: AppStack;
  let template: Template;

  beforeAll(() => {
    const app = new App();
    stack = new AppStack(app, "Test", { env: PROD, webAssetPath: fakeWebDist() });
    Aspects.of(app).add(new AwsSolutionsChecks());
    app.synth();
    template = Template.fromStack(stack);
  });

  it("passes cdk-nag AwsSolutions checks", () => {
    expect(nagErrors(stack)).toEqual([]);
  });

  it("keeps the table schema in sync with the local table", () => {
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "GSI1PK", KeyType: "HASH" },
            { AttributeName: "GSI1SK", KeyType: "RANGE" },
          ],
        }),
      ],
      StreamSpecification: { StreamViewType: "NEW_AND_OLD_IMAGES" },
      Replicas: [Match.objectLike({ DeletionProtectionEnabled: true, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })],
    });
  });

  it("retains data stores on stack deletion", () => {
    template.hasResource("AWS::DynamoDB::GlobalTable", { DeletionPolicy: "Retain" });
    template.hasResource("AWS::Cognito::UserPool", { DeletionPolicy: "Retain" });
  });

  it("runs the API on Node 22 arm64 without secrets in its environment", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      Environment: {
        Variables: Match.objectLike({ TABLE_NAME: Match.anyValue(), OIDC_ISSUER: Match.anyValue() }),
      },
    });
    const fns = template.findResources("AWS::Lambda::Function");
    for (const fn of Object.values(fns)) {
      const vars = Object.keys((fn.Properties?.Environment?.Variables ?? {}) as Record<string, unknown>);
      expect(vars.filter((v) => /SECRET|TOKEN|PASSWORD|KEY/i.test(v))).toEqual([]);
    }
  });

  it("is invite-only", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      DeletionProtection: "ACTIVE",
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
    });
  });

  it("routes /v1/* to the API uncached and keeps the bucket private", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: [
          Match.objectLike({
            PathPattern: "/v1/*",
            ViewerProtocolPolicy: "https-only",
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad", // CachingDisabled
          }),
        ],
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
      }),
    });
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });
});

describe("PipelineStack", () => {
  let stack: PipelineStack;
  let template: Template;

  beforeAll(() => {
    const app = new App();
    stack = new PipelineStack(app, "Pipeline", { env: PROD, webAssetPath: fakeWebDist() });
    Aspects.of(app).add(new AwsSolutionsChecks());
    app.synth();
    template = Template.fromStack(stack);
  });

  it("passes cdk-nag AwsSolutions checks", () => {
    expect(nagErrors(stack)).toEqual([]);
  });

  it("builds from the GitHub main branch through a connection", () => {
    template.hasResourceProperties("AWS::CodeStarConnections::Connection", { ProviderType: "GitHub" });
    template.hasResourceProperties("AWS::CodePipeline::Pipeline", {
      PipelineType: "V2",
      Stages: Match.arrayWith([
        Match.objectLike({
          Name: "Source",
          Actions: [
            Match.objectLike({
              Configuration: Match.objectLike({ FullRepositoryId: "Traxs/pophq", BranchName: "main" }),
            }),
          ],
        }),
      ]),
    });
  });

  it("runs the checks before synth and smoke-tests after deploy", () => {
    const buildSpecs = JSON.stringify(template.findResources("AWS::CodeBuild::Project"));
    for (const cmd of ["npm ci", "npm run lint", "npm run typecheck", "npm run test:unit", "npm run build"]) {
      expect(buildSpecs).toContain(cmd);
    }
    expect(buildSpecs).toContain("/v1/health");
  });

  it("deploys the Prod stage with self-mutation", () => {
    const stages = template.findResources("AWS::CodePipeline::Pipeline");
    const names = JSON.stringify(stages);
    expect(names).toContain("UpdatePipeline");
    expect(names).toContain("Prod");
  });
});

describe("AppStage", () => {
  it("runs cdk-nag on the app stack inside a stage", () => {
    const stage = new AppStage(new App(), "Prod", { env: PROD, webAssetPath: fakeWebDist() });
    stage.synth();
    expect(nagErrors(stage.app)).toEqual([]);
    expect(Annotations.fromStack(stage.app).findWarning("*", Match.stringLikeRegexp("AwsSolutions-.*"))).toEqual([]);
  });
});
