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
      TimeToLiveSpecification: { AttributeName: "expiresAtEpoch", Enabled: true },
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
      ExplicitAuthFlows: ["ALLOW_USER_AUTH"],
      RefreshTokenRotation: { Feature: "ENABLED", RetryGracePeriodSeconds: 60 },
      RefreshTokenValidity: 129_600, // 90 days, in minutes
      AccessTokenValidity: 60,
      EnableTokenRevocation: true,
    });
  });

  it("sends a strict Content Security Policy and other security headers", () => {
    const policy = JSON.stringify(template.findResources("AWS::CloudFront::ResponseHeadersPolicy"));
    for (const directive of ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'"]) {
      expect(policy).toContain(directive);
    }
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).toContain("Permissions-Policy");
    const dist = JSON.stringify(template.findResources("AWS::CloudFront::Distribution"));
    expect(dist).toContain("ResponseHeadersPolicyId");
    expect(dist).not.toContain("67f7725c-6f97-4210-82d7-5512b31e9d03"); // managed SecurityHeadersPolicy
  });

  it("keeps a separate, protected history table fed by the main table's stream", () => {
    const tables = template.findResources("AWS::DynamoDB::GlobalTable");
    expect(Object.keys(tables)).toHaveLength(2);
    for (const t of Object.values(tables)) {
      expect(t.Properties?.Replicas?.[0]?.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled).toBe(true);
      expect(t.DeletionPolicy).toBe("Retain");
    }
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      StartingPosition: "TRIM_HORIZON",
      BisectBatchOnFunctionError: true,
      MaximumRetryAttempts: 3,
      DestinationConfig: Match.objectLike({ OnFailure: Match.anyValue() }),
    });
    template.resourceCountIs("AWS::SQS::Queue", 1);
  });

  it("rolls new API code out to 10% first and rolls back on errors", () => {
    template.hasResourceProperties("AWS::Lambda::Alias", { Name: "live" });
    template.hasResourceProperties("AWS::CodeDeploy::DeploymentGroup", {
      DeploymentConfigName: "CodeDeployDefault.LambdaCanary10Percent5Minutes",
      AutoRollbackConfiguration: Match.objectLike({
        Enabled: true,
        Events: Match.arrayWith(["DEPLOYMENT_FAILURE", "DEPLOYMENT_STOP_ON_ALARM"]),
      }),
      AlarmConfiguration: Match.objectLike({ Enabled: true }),
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "Errors",
      Namespace: "AWS/Lambda",
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
    });
    // API Gateway must call the alias, not the unversioned function.
    const api = JSON.stringify(template.findResources("AWS::ApiGateway::Method"));
    expect(api).toContain("Live");
  });

  it("lets the API manage logins and check bot issuers in its own user pool only", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              "cognito-idp:AdminCreateUser",
              "cognito-idp:AdminDeleteUser",
              "cognito-idp:AdminListGroupsForUser",
              "cognito-idp:AdminSetUserPassword",
              "cognito-idp:ListUsers",
            ],
            Effect: "Allow",
            Resource: Match.objectLike({ "Fn::GetAtt": Match.arrayWith(["Arn"]) }),
          }),
        ]),
      }),
    });
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).not.toContain("cognito-idp:*");
    expect(policies).not.toContain("AdminGetUser");
  });

  it("defines the app roles as Cognito groups", () => {
    for (const name of ["owner", "officer", "player"]) {
      template.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: name });
    }
  });

  it("uses managed login with emailed one-time codes", () => {
    template.hasResourceProperties("AWS::Cognito::UserPoolDomain", { ManagedLoginVersion: 2 });
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      Policies: Match.objectLike({ SignInPolicy: { AllowedFirstAuthFactors: ["PASSWORD", "EMAIL_OTP"] } }),
    });
    template.hasResourceProperties("AWS::Cognito::ManagedLoginBranding", {
      Settings: Match.objectLike({ categories: Match.objectLike({ global: Match.objectLike({ colorSchemeMode: "DYNAMIC" }) }) }),
      Assets: Match.arrayWith([Match.objectLike({ Category: "FORM_LOGO", ColorMode: "LIGHT", Extension: "SVG" })]),
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
  it("requires the CloudFront API key on every API method and caps requests per day", () => {
    const methods = Object.values(template.findResources("AWS::ApiGateway::Method"));
    expect(methods.length).toBeGreaterThan(0);
    for (const m of methods) expect(m.Properties?.ApiKeyRequired).toBe(true);
    template.hasResourceProperties("AWS::ApiGateway::UsagePlan", {
      Quota: { Limit: 20_000, Period: "DAY" },
      Throttle: { RateLimit: 20, BurstLimit: 40 },
    });
    template.resourceCountIs("AWS::ApiGateway::UsagePlanKey", 1);
    const dist = JSON.stringify(template.findResources("AWS::CloudFront::Distribution"));
    expect(dist).toContain('"HeaderName":"x-api-key"');
  });

  it("alerts at the $10 budget and trips the kill switch at $15", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: "/pophq/kill-switch", Value: "off" });
    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 10, Unit: "USD" }, TimeUnit: "MONTHLY", BudgetType: "COST" }),
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: "FORECASTED", Threshold: 100 }) }),
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: "ACTUAL", Threshold: 15, ThresholdType: "ABSOLUTE_VALUE" }),
        }),
      ]),
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ KILL_SWITCH_PARAMETER: Match.anyValue(), OIDC_ISSUER: Match.anyValue() }) },
    });
  });

  it("keeps the alert email out of the template", () => {
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(Object.values(template.toJSON().Parameters ?? {})).toContainEqual(
      expect.objectContaining({ Type: "AWS::SSM::Parameter::Value<String>", Default: "/pophq/alerts/email" }),
    );
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
    expect(buildSpecs).toMatch(/DIRECT_API\}v1\/health.*403/);
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
