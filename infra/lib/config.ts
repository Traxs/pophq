import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Fixed deployment target: one production account (spec: Platform). Not secret. */
export const PROD = { account: "529088263366", region: "eu-central-1" } as const;

export const REPO = { name: "Traxs/pophq", branch: "main" } as const;

/**
 * The custom domain, once it is registered and its hosted zone exists (P2.1).
 *
 * Left undefined the app keeps its CloudFront name and nothing below is created, so this file is
 * the whole switch. Fill in both fields after registering the domain:
 *
 *   aws route53 list-hosted-zones --query "HostedZones[?Name=='pophq.fyi.']"
 *
 * The zone id is written out rather than looked up: a `fromLookup` needs credentials and a
 * context cache at synth time, which a pipeline build does not reliably have.
 */
export const SITE: { domainName: string; hostedZoneId: string } | undefined = {
  domainName: "pophq.fyi",
  hostedZoneId: "Z024603319A9CK1ZSXZM4",
};

/**
 * CloudFront only accepts certificates from us-east-1, wherever the rest of the stack lives.
 */
export const CERTIFICATE_REGION = "us-east-1";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const API_ENTRY = join(REPO_ROOT, "api", "src", "lambda.ts");
export const KILL_SWITCH_ENTRY = join(REPO_ROOT, "api", "src", "ops", "killSwitch.ts");
export const HISTORY_ENTRY = join(REPO_ROOT, "api", "src", "ops", "historyWriter.ts");

/** SSM parameter with the budget alert email; created once by the owner (see README). */
export const ALERT_EMAIL_PARAMETER = "/pophq/alerts/email";
export const WEB_DIST = join(REPO_ROOT, "web", "dist");
export const LOCK_FILE = join(REPO_ROOT, "package-lock.json");
export const LOGIN_ASSETS = join(REPO_ROOT, "infra", "assets", "login");
