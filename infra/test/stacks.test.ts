import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Validations } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Match, Template } from "aws-cdk-lib/assertions";
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

// Same feature flags as `cdk synth` (cdk.json), so tests check what actually deploys.
const { context } = JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8")) as {
  context: Record<string, unknown>;
};
const newApp = () => new App({ context });

/** An app that runs cdk-nag like bin/pophq.ts: any unacknowledged finding makes synth throw. */
function nagApp(): App {
  const app = newApp();
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return app;
}

describe("AppStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = nagApp();
    const stack = new AppStack(app, "Test", { env: PROD, webAssetPath: fakeWebDist() });
    app.synth(); // throws on cdk-nag findings
    template = Template.fromStack(stack);
  });

  it("fails synth on a new, unacknowledged cdk-nag finding", () => {
    const app = nagApp();
    const stack = new AppStack(app, "Test", { env: PROD, webAssetPath: fakeWebDist() });
    new iam.Role(stack, "TooBroad", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") }).addToPolicy(
      new iam.PolicyStatement({ actions: ["dynamodb:*"], resources: ["*"] }),
    );
    expect(() => app.synth()).toThrow();
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

  it("runs the API on Node 24 arm64 without secrets in its environment", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
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
  let template: Template;

  beforeAll(() => {
    const app = nagApp();
    const stack = new PipelineStack(app, "PopHqPipeline", { env: PROD, webAssetPath: fakeWebDist() });
    app.synth(); // throws on cdk-nag findings, including inside the Prod stage
    template = Template.fromStack(stack);
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
  it("runs cdk-nag inside the stage", () => {
    const app = newApp(); // no app-level plugin: the stage's own checks must catch it
    const stage = new AppStage(app, "Prod", { env: PROD, webAssetPath: fakeWebDist() });
    new iam.Role(stage.app, "TooBroad", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") }).addToPolicy(
      new iam.PolicyStatement({ actions: ["s3:*"], resources: ["*"] }),
    );
    expect(() => app.synth()).toThrow();
  });
});
