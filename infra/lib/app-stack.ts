import { CfnOutput, Duration, RemovalPolicy, Stack, type CfnElement, type StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { S3_GRANT_ACTIONS, acknowledge, acknowledgeEach } from "./nag.js";
import { API_ENTRY, LOCK_FILE, REPO_ROOT } from "./config.js";

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
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 14, requireSymbols: false },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    users.addDomain("Domain", { cognitoDomain: { domainPrefix: `pophq-${this.account}` } });

    const api = this.api(table.tableName, users.userPoolProviderUrl);
    table.grantReadWriteData(api.handler);

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

    const cdn = new cloudfront.Distribution(this, "Cdn", {
      comment: "POP HQ",
      defaultRootObject: "index.html",
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        "/v1/*": {
          origin: new origins.RestApiOrigin(api.rest),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
      },
    });
    const origin = `https://${cdn.distributionDomainName}`;

    const client = users.addClient("WebClient", {
      generateSecret: false,
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`${origin}/callback`],
        logoutUrls: [origin],
      },
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
        s3deploy.Source.jsonData("config.json", { issuer: users.userPoolProviderUrl, clientId: client.userPoolClientId }),
      ],
      cacheControl: [s3deploy.CacheControl.fromString("no-cache")],
      prune: false,
      distribution: cdn,
      distributionPaths: ["/*"],
      memoryLimit: 512,
    });
    shell.node.addDependency(assets);

    this.url = new CfnOutput(this, "Url", { value: origin });
    new CfnOutput(this, "UserPoolId", { value: users.userPoolId });
    new CfnOutput(this, "TableName", { value: table.tableName });

    this.suppressions(table, bucket);
  }

  private api(tableName: string, issuer: string): { handler: NodejsFunction; rest: apigw.RestApi } {
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
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        format: OutputFormat.ESM,
        target: "node24",
        minify: true,
        sourceMap: true,
        mainFields: ["module", "main"],
        // Bundle the AWS SDK too, so the deployed version matches the tested one.
        externalModules: [],
        banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });

    const rest = new apigw.LambdaRestApi(this, "Rest", {
      handler,
      proxy: true,
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
    return { handler, rest };
  }

  private suppressions(table: dynamodb.TableV2, bucket: s3.Bucket): void {
    const arn = (c: Construct) => `<${this.getLogicalId(c.node.defaultChild as CfnElement)}.Arn>`;
    acknowledgeEach(
      this,
      "AwsSolutions-IAM4",
      [
        "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs",
      ],
      "AWS managed policies for Lambda logging and the API Gateway logging role.",
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
        `Resource::arn:aws:s3:::cdk-hnb659fds-assets-${this.account}-${this.region}/*`,
      ],
      "CDK BucketDeployment helper: copies the web build from the CDK asset bucket into the web bucket.",
    );
    acknowledge(this, {
      "AwsSolutions-L1": "The CDK BucketDeployment helper pins its own runtime; the API uses Node 24.",
      "AwsSolutions-S1": "Web bucket holds public build output only; CloudFront logging arrives with Milestone 2.",
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
      "AwsSolutions-COG1": "Length 14 without composition rules (NIST 800-63B); sign-in moves to email codes in P2.3.",
      "AwsSolutions-COG2": "MFA is required for officers in P2.6; players use email codes.",
      "AwsSolutions-COG3": "Threat protection needs the Plus plan; not justified for 100 users.",
      "AwsSolutions-COG8": "Threat protection needs the Plus plan; not justified for 100 users."
    });
  }
}
