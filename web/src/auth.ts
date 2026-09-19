import { InMemoryWebStorage, UserManager, WebStorageStateStore } from "oidc-client-ts";

export interface AuthConfig {
  issuer: string;
  clientId: string;
}

// Locally this is the mock issuer from dev/docker-compose.yml. In AWS the deploy writes
// /config.json with the Cognito issuer and client id (public values, not secrets).
let config: AuthConfig = {
  issuer: import.meta.env.VITE_OIDC_ISSUER ?? "http://localhost:8081/pophq",
  clientId: import.meta.env.VITE_OIDC_CLIENT_ID ?? "pophq-web",
};

/** Loads /config.json in production builds; local development keeps the defaults above. */
export async function loadAuthConfig(fetcher: typeof fetch = fetch): Promise<void> {
  if (import.meta.env.DEV) return;
  const res = await fetcher("/config.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`config.json: HTTP ${res.status}`);
  config = parseAuthConfig(await res.json());
  manager = undefined;
}

export function parseAuthConfig(value: unknown): AuthConfig {
  const v = value as Partial<AuthConfig> | null;
  if (typeof v?.issuer !== "string" || !v.issuer.startsWith("https://") || typeof v.clientId !== "string" || !v.clientId) {
    throw new Error("config.json is missing issuer or clientId");
  }
  return { issuer: v.issuer, clientId: v.clientId };
}

export interface DevPersona {
  clientId: string;
  name: string;
  role: string;
  description: string;
}

/**
 * Local-only test people. The mock issuer maps each client id to a subject and groups
 * (dev/docker-compose.yml); the seed links subjects to game accounts. Not shipped to production.
 */
export const DEV_PERSONAS: DevPersona[] = import.meta.env.DEV
  ? [
      { clientId: "pophq-dev-player", name: "Poppy", role: "Player", description: "Member with an alt account (Goatzilla)" },
      { clientId: "pophq-dev-officer", name: "Aurora", role: "Officer · R4", description: "Sees the Members table" },
      { clientId: "pophq-dev-owner", name: "Polaris", role: "Site owner", description: "Runs POP HQ; owner tools" },
      { clientId: "pophq-dev-newcomer", name: "Newcomer", role: "No account yet", description: "Signed in, waiting for an officer" },
    ]
  : [];

const CLIENT_KEY = "pophq.clientId";

const readClientId = (): string => {
  try {
    return window.sessionStorage.getItem(CLIENT_KEY) ?? config.clientId;
  } catch {
    return config.clientId;
  }
};

function build(clientId: string): UserManager {
  return new UserManager({
    authority: config.issuer,
    client_id: clientId,
    redirect_uri: `${window.location.origin}/callback`,
    post_logout_redirect_uri: window.location.origin,
    response_type: "code", // authorization code + PKCE
    scope: "openid",
    // Tokens stay in memory (spec: Web app). Refresh-token handling arrives with Cognito.
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    automaticSilentRenew: false,
  });
}

let manager: UserManager | undefined;

/** The active user manager; the callback must use the same client id as the sign-in that started it. */
export const userManager = (): UserManager => (manager ??= build(readClientId()));

/** Starts sign-in, optionally as a local dev persona. */
export function startSignIn(returnTo: string, clientId: string = config.clientId): Promise<void> {
  try {
    window.sessionStorage.setItem(CLIENT_KEY, clientId);
  } catch {
    /* ignore */
  }
  manager = build(clientId);
  return manager.signinRedirect({ state: returnTo === "/callback" ? "/" : returnTo });
}
