import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type CfnElement, type StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as codedeploy from "aws-cdk-lib/aws-codedeploy";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource, SqsDlq } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import { S3_GRANT_ACTIONS, acknowledge, acknowledgeEach } from "./nag.js";
import { ALERT_EMAIL_PARAMETER, API_ENTRY, HISTORY_ENTRY, LOCK_FILE, LOGIN_ASSETS, REPO_ROOT } from "./config.js";
import { CostGuard } from "./cost-guard.js";
import { NODE_BUNDLING } from "./node-bundling.js";

export interface AppStackProps extends StackProps {
  /** Built web app (web/dist). */
  webAssetPath: string;
}

/**
 * Milestone 1 (docs/PLAN.md): table, API, web hosting and a minimal user pool.
 * WAF, custom domain, origin-verify header and the Lambda authorizer follow in Milestone 2.
 */
export class AppStack extends Stack {
  readonly url: CfnOutput;
  readonly directApiUrl: CfnOutput;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    // Keep in sync with api/src/data/table.ts.
    const table = new dynamodb.TableV2(this, "Table", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      globalSecondaryIndexes: [
        {
          indexName: "GSI1",
          partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
        },
      ],
      dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      // Agent idempotency receipts expire after a day; durable domain/history records do not set it.
      timeToLiveAttribute: "expiresAtEpoch",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const users = new cognito.UserPool(this, "Users", {
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false, // invite-only (spec: Identity)
      signInAliases: { email: true },
      signInCaseSensitive: false,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Choice-based sign-in: an emailed one-time code, or a password (Cognito requires
      // passwords to stay allowed). Passkeys follow with the custom domain (P2.3), because a
      // passkey is bound to the domain it was created on.
      signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: true } },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 14, requireSymbols: false },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // App roles, not game ranks (R1–R5 live on the game account). Every signed-in person is a
    // player; officer adds roster tools; owner runs the site. Keep in sync with domain/principal.ts.
    for (const [groupName, precedence, description] of [
      ["owner", 0, "Site owner: runs POP HQ, owner tools"],
      ["officer", 10, "Alliance officers: roster and planning tools"],
      ["player", 20, "Alliance members (every signed-in person is treated as a player)"],
    ] as const) {
      new cognito.CfnUserPoolGroup(this, `Group-${groupName}`, {
        userPoolId: users.userPoolId,
        groupName,
        precedence,
        description,
      });
    }

    const loginDomain = users.addDomain("Domain", {
      cognitoDomain: { domainPrefix: `pophq-${this.account}` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // Every change to the main table is streamed here and kept for good (DATA-04). Separate
    // table: it is written only by the stream handler and read for timelines and charts.
    const history = new dynamodb.TableV2(this, "History", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const evidence = new s3.Bucket(this, "Evidence", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const guard = new CostGuard(this, "CostGuard", {
      monthlyBudgetUsd: 10,
      tripAtUsd: 15,
      alertEmailParameter: ALERT_EMAIL_PARAMETER,
    });

    const api = this.api(
      table.tableName,
      users.userPoolProviderUrl,
      guard.killSwitch.parameterName,
      users.userPoolId,
      history.tableName,
      evidence.bucketName,
    );
    table.grantReadWriteData(api.handler);
    history.grantReadData(api.handler);
    evidence.grantReadWrite(api.handler);
    guard.killSwitch.grantRead(api.handler);
    // Officer invites create and, on failure, remove logins in this pool (P4.1). No other
    // Cognito rights: the API never reads passwords, tokens or other pools.
    api.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:ListUsers",
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminSetUserPassword",
          "cognito-idp:AdminUserGlobalSignOut",
          "cognito-idp:AdminDeleteUser",
          "cognito-idp:AdminListGroupsForUser",
        ],
        resources: [users.userPoolArn],
      }),
    );

    // Only CloudFront knows the API key, so calls to the execute-api URL get 403 before any
    // Lambda runs. The usage-plan quota is a hard ceiling on API cost, even under a flood.
    const cloudFrontKey = api.rest.addApiKey("CloudFrontKey", { description: "Sent by CloudFront only" });
    const plan = api.rest.addUsagePlan("Plan", {
      throttle: { rateLimit: 20, burstLimit: 40 },
      quota: { limit: 20_000, period: apigw.Period.DAY },
    });
    plan.addApiKey(cloudFrontKey);
    plan.addApiStage({ stage: api.rest.deploymentStage });
    // The generated key value is read at deploy time; it never appears in Git or the template.
    const cloudFrontKeyValue = new cr.AwsCustomResource(this, "CloudFrontKeyValue", {
      onUpdate: {
        service: "APIGateway",
        action: "getApiKey",
        parameters: { apiKey: cloudFrontKey.keyId, includeValue: true },
        physicalResourceId: cr.PhysicalResourceId.of(cloudFrontKey.keyId),
        logging: cr.Logging.withDataHidden(),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ["apigateway:GET"], resources: [cloudFrontKey.keyArn] }),
      ]),
      installLatestAwsSdk: false,
    }).getResponseField("value");

    this.historyWriter(table, history);

    const bucket = new s3.Bucket(this, "Web", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Client-side routes (/power, /callback, …) serve index.html; files keep their path.
    const spaRewrite = new cloudfront.Function(this, "SpaRewrite", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) { var r = event.request; if (r.uri.indexOf('.') === -1) { r.uri = '/index.html'; } return r; }",
      ),
    });

    // Strict CSP: only our own scripts and styles run, which is what makes keeping the sign-in in
    // localStorage acceptable (decision in docs/PLAN.md). Sign-in talks to Cognito only.
    const authDomain = loginDomain.baseUrl();
    const headers = new cloudfront.ResponseHeadersPolicy(this, "Headers", {
      comment: "POP HQ security headers",
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' data:",
            "font-src 'self'",
            `connect-src 'self' https://cognito-idp.${this.region}.amazonaws.com ${authDomain}`,
            "frame-ancestors 'none'",
            "form-action 'self'",
            "base-uri 'self'",
            "object-src 'none'",
            "upgrade-insecure-requests",
          ].join("; "),
          override: true,
        },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()", override: true },
        ],
      },
    });

    const cdn = new cloudfront.Distribution(this, "Cdn", {
      comment: "POP HQ",
      defaultRootObject: "index.html",
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        "/v1/*": {
          origin: new origins.RestApiOrigin(api.rest, { customHeaders: { "x-api-key": cloudFrontKeyValue } }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
      },
    });
    const origin = `https://${cdn.distributionDomainName}`;

    const client = users.addClient("WebClient", {
      generateSecret: false,
      // Only the choice-based flow the managed login page uses; see the override below.
      authFlows: { user: true },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      // People enter an emailed code about four times a year. The expiry counts from that sign-in;
      // rotated refresh tokens keep it. Disabling a login (ID-08) revokes its tokens at once.
      refreshTokenValidity: Duration.days(90),
      // Every refresh returns a new refresh token; the old one works for 60 s more so several
      // open tabs refreshing at once don't sign each other out (FM-16).
      refreshTokenRotationGracePeriod: Duration.seconds(60),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`${origin}/callback`],
        logoutUrls: [origin],
      },
    });

    // Refresh-token rotation doesn't work with ALLOW_REFRESH_TOKEN_AUTH, which CDK always adds.
    // Tokens are refreshed through the OAuth token endpoint instead, which rotation supports.
    (client.node.defaultChild as cognito.CfnUserPoolClient).addPropertyOverride("ExplicitAuthFlows", ["ALLOW_USER_AUTH"]);

    // Managed login in the POP HQ style: colors from web/src/styles.css, light and dark mode,
    // snowflake logo. settings.json started from Cognito's own default settings document.
    const loginAsset = (file: string) => readFileSync(join(LOGIN_ASSETS, file)).toString("base64");
    new cognito.CfnManagedLoginBranding(this, "LoginBranding", {
      userPoolId: users.userPoolId,
      clientId: client.userPoolClientId,
      settings: JSON.parse(readFileSync(join(LOGIN_ASSETS, "settings.json"), "utf8")) as unknown,
      assets: (["LIGHT", "DARK"] as const).flatMap((colorMode) => {
        const bytes = loginAsset(`logo-${colorMode.toLowerCase()}.svg`);
        return ["FORM_LOGO", "FAVICON_SVG"].map((category) => ({ category, colorMode, extension: "SVG", bytes }));
      }),
    });

    // Hashed assets never change: cache for a year and keep old files (prune: false) so open
    // tabs still load them after a deploy (FM-15). index.html and config.json are revalidated.
    const assets = new s3deploy.BucketDeployment(this, "WebAssets", {
      destinationBucket: bucket,
      sources: [s3deploy.Source.asset(props.webAssetPath, { exclude: ["index.html"] })],
      cacheControl: [s3deploy.CacheControl.fromString("public, max-age=31536000, immutable")],
      prune: false,
      memoryLimit: 512,
    });
    const shell = new s3deploy.BucketDeployment(this, "WebShell", {
      destinationBucket: bucket,
      sources: [
        s3deploy.Source.asset(props.webAssetPath, { exclude: ["*", "!index.html"] }),
        s3deploy.Source.jsonData("config.json", {
          issuer: users.userPoolProviderUrl,
          clientId: client.userPoolClientId,
          authDomain,
        }),
      ],
      cacheControl: [s3deploy.CacheControl.fromString("no-cache")],
      prune: false,
      distribution: cdn,
      distributionPaths: ["/*"],
      memoryLimit: 512,
    });
    shell.node.addDependency(assets);

    this.url = new CfnOutput(this, "Url", { value: origin });
    this.directApiUrl = new CfnOutput(this, "DirectApiUrl", { value: api.rest.url });
    new CfnOutput(this, "UserPoolId", { value: users.userPoolId });
    new CfnOutput(this, "TableName", { value: table.tableName });

    this.suppressions(table, bucket, evidence);
  }

  /** Stream handler: writes one history entry per change; failures park in a dead-letter queue. */
  private historyWriter(source: dynamodb.TableV2, history: dynamodb.TableV2): void {
    const failures = new sqs.Queue(this, "HistoryFailures", {
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    const writer = new NodejsFunction(this, "HistoryWriter", {
      entry: HISTORY_ENTRY,
      projectRoot: REPO_ROOT,
      depsLockFilePath: LOCK_FILE,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup: new logs.LogGroup(this, "HistoryWriterLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: { HISTORY_TABLE_NAME: history.tableName },
      bundling: NODE_BUNDLING,
    });
    history.grantWriteData(writer);
    writer.addEventSource(
      new DynamoEventSource(source, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 100,
        maxBatchingWindow: Duration.seconds(10),
        retryAttempts: 3,
        bisectBatchOnError: true,
        onFailure: new SqsDlq(failures),
      }),
    );
  }

  private api(
    tableName: string,
    issuer: string,
    killSwitch: string,
    userPoolId: string,
    historyTableName: string,
    evidenceBucketName: string,
  ): { handler: NodejsFunction; rest: apigw.RestApi; alias: lambda.Alias } {
    const handler = new NodejsFunction(this, "Api", {
      entry: API_ENTRY,
      projectRoot: REPO_ROOT,
      depsLockFilePath: LOCK_FILE,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(10),
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup: new logs.LogGroup(this, "ApiLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        TABLE_NAME: tableName,
        OIDC_ISSUER: issuer,
        KILL_SWITCH_PARAMETER: killSwitch,
        USER_POOL_ID: userPoolId,
        HISTORY_TABLE_NAME: historyTableName,
        EVIDENCE_BUCKET_NAME: evidenceBucketName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: NODE_BUNDLING,
    });

    /**
     * New code goes live for 10 % of requests for five minutes first. If it errors, CodeDeploy
     * puts everyone back on the previous version and the deploy fails (PLT-02).
     */
    const alias = new lambda.Alias(this, "Live", { aliasName: "live", version: handler.currentVersion });
    const failing = new cloudwatch.Alarm(this, "ApiErrors", {
      alarmDescription: "POP HQ API returned errors; rolls back a running deploy.",
      metric: alias.metricErrors({ period: Duration.minutes(1), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new codedeploy.LambdaDeploymentGroup(this, "ApiCanary", {
      alias,
      deploymentConfig: codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
      alarms: [failing],
      autoRollback: { failedDeployment: true, deploymentInAlarm: true },
    });

    const rest = new apigw.LambdaRestApi(this, "Rest", {
      handler: alias,
      proxy: true,
      defaultMethodOptions: { apiKeyRequired: true },
      endpointConfiguration: { types: [apigw.EndpointType.REGIONAL] },
      cloudWatchRole: true,
      cloudWatchRoleRemovalPolicy: RemovalPolicy.RETAIN,
      deployOptions: {
        stageName: "prod",
        throttlingRateLimit: 20,
        throttlingBurstLimit: 40,
        loggingLevel: apigw.MethodLoggingLevel.ERROR,
        accessLogDestination: new apigw.LogGroupLogDestination(
          new logs.LogGroup(this, "ApiAccessLogs", {
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: RemovalPolicy.DESTROY,
          }),
        ),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
      },
    });
    return { handler, rest, alias };
  }

  private suppressions(table: dynamodb.TableV2, bucket: s3.Bucket, evidence: s3.Bucket): void {
    const arn = (c: Construct) => `<${this.getLogicalId(c.node.defaultChild as CfnElement)}.Arn>`;
    acknowledgeEach(
      this,
      "AwsSolutions-IAM4",
      [
        "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs",
        "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSCodeDeployRoleForLambdaLimited",
      ],
      "AWS managed policies for Lambda logging, the API Gateway logging role and the CodeDeploy canary.",
    );
    acknowledgeEach(
      this,
      "AwsSolutions-IAM5",
      [`Resource::${arn(table)}/index/*`],
      "The API queries this table's own indexes (CDK grantReadWriteData).",
    );
    acknowledgeEach(
      this,
      "AwsSolutions-IAM5",
      [
        ...S3_GRANT_ACTIONS,
        "Resource::*",
        `Resource::${arn(bucket)}/*`,
        `Resource::${arn(evidence)}/*`,
        `Resource::arn:aws:s3:::cdk-hnb659fds-assets-${this.account}-${this.region}/*`,
      ],
      "The web deployment and private evidence API need object-level access only in their own buckets.",
    );
    acknowledge(this, {
      "AwsSolutions-L1": "The CDK BucketDeployment helper pins its own runtime; the API uses Node 24.",
      "AwsSolutions-S1": "Web output and private evidence are low-volume; access logging arrives with Milestone 2.",
      "AwsSolutions-S10": "Only CloudFront reads the bucket (OAC); bucket policy enforces TLS.",
      "AwsSolutions-CFR1": "The alliance is international; no geo restriction.",
      "AwsSolutions-CFR2": "WAF comes with the CloudFront flat-rate plan in Milestone 2 (P2.2).",
      "AwsSolutions-CFR3": "Access logging comes with Milestone 2.",
      "AwsSolutions-CFR4": "Default CloudFront certificate until pophq.fyi is bought (P2.1).",
      "AwsSolutions-CFR7": "The S3 origin uses origin access control (OAC).",
      "AwsSolutions-APIG2": "The API validates every request body with zod.",
      "AwsSolutions-APIG3": "WAF sits on CloudFront in Milestone 2 (P2.2).",
      "AwsSolutions-APIG4": "The API checks the Cognito token itself; the Lambda authorizer comes in P2.5.",
      "AwsSolutions-COG4": "The API checks the Cognito token itself; the Lambda authorizer comes in P2.5.",
      "AwsSolutions-SQS3": "This queue is the dead-letter queue for the history stream; it needs none itself.",
      "AwsSolutions-COG1": "Length 14 without composition rules (NIST 800-63B); sign-in moves to email codes in P2.3.",
      "AwsSolutions-COG2": "MFA is required for officers in P2.6; players use email codes.",
      "AwsSolutions-COG3": "Threat protection needs the Plus plan; not justified for 100 users.",
      "AwsSolutions-COG8": "Threat protection needs the Plus plan; not justified for 100 users."
    });
  }
}
