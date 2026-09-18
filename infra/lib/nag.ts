import { Validations } from "aws-cdk-lib";
import type { IConstruct } from "constructs";

/** Acknowledges cdk-nag findings on a scope and everything below it. Every entry needs a reason. */
export function acknowledge(scope: IConstruct, findings: Record<string, string>): void {
  for (const [id, reason] of Object.entries(findings)) Validations.of(scope).acknowledge({ id, reason });
}

/**
 * Acknowledges several findings of one rule with the same reason. cdk-nag 3 reports each
 * wildcard separately (e.g. `AwsSolutions-IAM5[Action::s3:List*]`) and has no prefix matching.
 */
export function acknowledgeEach(scope: IConstruct, rule: string, findings: string[], reason: string): void {
  for (const f of findings) Validations.of(scope).acknowledge({ id: `${rule}[${f}]`, reason });
}

/** Wildcard actions from CDK's standard S3 read/write grants. */
export const S3_GRANT_ACTIONS = ["s3:Abort*", "s3:DeleteObject*", "s3:GetBucket*", "s3:GetObject*", "s3:List*"].map(
  (a) => `Action::${a}`,
);
