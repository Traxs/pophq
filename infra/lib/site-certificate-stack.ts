import { Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";

export interface SiteCertificateStackProps extends StackProps {
  domainName: string;
  hostedZoneId: string;
}

/**
 * The TLS certificate for the custom domain (P2.1).
 *
 * It lives in its own stack because CloudFront only reads certificates from us-east-1, while the
 * rest of POP HQ is in eu-central-1. Route 53 itself is global, so the validation records are
 * written into the same hosted zone from here.
 *
 * Validation is by DNS rather than email: CDK writes the record itself, so the certificate issues
 * without anybody watching a mailbox, and renews the same way for as long as the zone exists.
 */
export class SiteCertificateStack extends Stack {
  readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: SiteCertificateStackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.domainName,
    });

    this.certificate = new acm.Certificate(this, "Certificate", {
      domainName: props.domainName,
      // Covers www as well, so the redirect below can be added later without reissuing.
      subjectAlternativeNames: [`www.${props.domainName}`],
      validation: acm.CertificateValidation.fromDns(zone),
    });
  }
}
