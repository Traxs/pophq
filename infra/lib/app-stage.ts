import { Stage, Validations, type CfnOutput, type StageProps } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import type { Construct } from "constructs";
import { AppStack } from "./app-stack.js";
import { CERTIFICATE_REGION } from "./config.js";
import { SiteCertificateStack } from "./site-certificate-stack.js";

export interface AppStageProps extends StageProps {
  webAssetPath: string;
  /** The custom domain once it exists (P2.1); config.ts supplies it for the real pipeline. */
  site?: { domainName: string; hostedZoneId: string } | undefined;
}

/** One deployable copy of POP HQ. There is only production (spec: Platform). */
export class AppStage extends Stage {
  readonly app: AppStack;
  readonly url: CfnOutput;
  readonly directApiUrl: CfnOutput;

  constructor(scope: Construct, id: string, props: AppStageProps) {
    super(scope, id, props);

    // The certificate stack only exists once a domain is configured, and sits in us-east-1
    // because that is where CloudFront reads certificates from. crossRegionReferences lets the
    // eu-central-1 stack use its ARN; without it CDK refuses to carry a value between regions.
    const site = props.site
      ? {
          ...props.site,
          certificate: new SiteCertificateStack(this, "SiteCertificate", {
            stackName: "PopHqSiteCertificate",
            env: { account: props.env?.account, region: CERTIFICATE_REGION },
            crossRegionReferences: true,
            ...props.site,
          }).certificate,
        }
      : undefined;

    this.app = new AppStack(this, "App", {
      stackName: "PopHq",
      webAssetPath: props.webAssetPath,
      ...(site ? { site, crossRegionReferences: true } : {}),
    });
    this.url = this.app.url;
    this.directApiUrl = this.app.directApiUrl;
    // Validation plugins are registered per stage; the app's plugins don't reach inside it.
    Validations.of(this).addPlugins(new AwsSolutionsChecks(this));
  }
}
