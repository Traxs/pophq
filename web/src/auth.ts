import { InMemoryWebStorage, UserManager, WebStorageStateStore, type User } from "oidc-client-ts";

export interface AuthConfig {
  issuer: string;
  clientId: string;
  /** Cognito managed-login domain, for sign-out and token revocation. Absent locally. */
  authDomain?: string;
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
  if (v.authDomain !== undefined && (typeof v.authDomain !== "string" || !v.authDomain.startsWith("https://"))) {
    throw new Error("config.json has an invalid authDomain");
  }
  return { issuer: v.issuer, clientId: v.clientId, ...(v.authDomain ? { authDomain: v.authDomain.replace(/\/$/, "") } : {}) };
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

// The sign-in survives reloads and new tabs (decision: tokens in localStorage, rotated refresh
// tokens, strict CSP). Falls back to memory when storage is blocked, e.g. in private modes.
function persistentStore(): Storage {
  try {
    window.localStorage.setItem("pophq.probe", "1");
    window.localStorage.removeItem("pophq.probe");
    return window.localStorage;
  } catch {
    return new InMemoryWebStorage();
  }
}

const readClientId = (): string => {
  try {
    return window.localStorage.getItem(CLIENT_KEY) ?? config.clientId;
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
    userStore: new WebStorageStateStore({ store: persistentStore() }),
    // Tokens are refreshed on demand in currentUser(), under a lock shared by all tabs.
    automaticSilentRenew: false,
  });
}

let manager: UserManager | undefined;

/** The active user manager; the callback must use the same client id as the sign-in that started it. */
export const userManager = (): UserManager => (manager ??= build(readClientId()));

/** Seconds before expiry at which an access token is renewed. */
export const REFRESH_MARGIN_S = 60;

/** What to do with a stored sign-in: use it, renew it with the refresh token, or treat it as signed out. */
export function tokenAction(
  user: { expires_in?: number | undefined; refresh_token?: string | undefined } | null,
): "use" | "refresh" | "none" {
  if (!user) return "none";
  if ((user.expires_in ?? 0) > REFRESH_MARGIN_S) return "use";
  return user.refresh_token ? "refresh" : "none";
}

const withRefreshLock = <T>(fn: () => Promise<T>): Promise<T> =>
  typeof navigator !== "undefined" && navigator.locks
    ? (navigator.locks.request("pophq-token-refresh", fn) as Promise<T>)
    : fn();

/**
 * The signed-in user with a usable access token, renewed when needed. One tab refreshes at a
 * time (FM-16): the others wait, then read the rotated tokens from storage instead of spending
 * the old refresh token.
 */
export function currentUser(): Promise<User | null> {
  return withRefreshLock(async () => {
    const um = userManager();
    const user = await um.getUser();
    switch (tokenAction(user)) {
      case "use":
        return user;
      case "refresh":
        try {
          return await um.signinSilent();
        } catch {
          await um.removeUser();
          return null;
        }
      default:
        if (user) await um.removeUser();
        return null;
    }
  });
}

/** Clears the sign-in in this browser only (e.g. after the API rejected the token). */
export const forgetSignIn = (): Promise<void> => userManager().removeUser();

/**
 * Signs out fully: revokes the refresh token, clears local tokens and ends the Cognito session,
 * so the next sign-in asks for a code again. Returns true when the page is being redirected.
 */
export async function signOutEverywhere(): Promise<boolean> {
  const um = userManager();
  const user = await um.getUser();
  await um.removeUser();
  if (!config.authDomain) return false;
  if (user?.refresh_token) {
    await fetch(`${config.authDomain}/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: user.refresh_token, client_id: config.clientId }),
    }).catch(() => undefined); // best effort; the token expires anyway
  }
  const params = new URLSearchParams({ client_id: config.clientId, logout_uri: window.location.origin });
  window.location.assign(`${config.authDomain}/logout?${params.toString()}`);
  return true;
}

/** Starts sign-in, optionally as a local dev persona. */
export function startSignIn(returnTo: string, clientId: string = config.clientId): Promise<void> {
  try {
    window.localStorage.setItem(CLIENT_KEY, clientId);
  } catch {
    /* ignore */
  }
  manager = build(clientId);
  return manager.signinRedirect({ state: returnTo === "/callback" ? "/" : returnTo });
}
