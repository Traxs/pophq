import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Fixed deployment target: one production account (spec: Platform). Not secret. */
export const PROD = { account: "529088263366", region: "eu-central-1" } as const;

export const REPO = { name: "Traxs/pophq", branch: "main" } as const;

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const API_ENTRY = join(REPO_ROOT, "api", "src", "lambda.ts");
export const KILL_SWITCH_ENTRY = join(REPO_ROOT, "api", "src", "ops", "killSwitch.ts");

/** SSM parameter with the budget alert email; created once by the owner (see README). */
export const ALERT_EMAIL_PARAMETER = "/pophq/alerts/email";
export const WEB_DIST = join(REPO_ROOT, "web", "dist");
export const LOCK_FILE = join(REPO_ROOT, "package-lock.json");
