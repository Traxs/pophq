import type { User } from "oidc-client-ts";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, createApi, type GameAccount, type Me } from "./api";
import { currentUser, forgetSignIn, signOutEverywhere, startSignIn, userManager } from "./auth";
import { navigate } from "./router";

const ACTING_KEY = "pophq.actingAs";

// Remembered account choice is a per-device convenience; storage may be unavailable.
const readActing = (): string | undefined => {
  try {
    return window.localStorage.getItem(ACTING_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};
const writeActing = (id: string) => {
  try {
    window.localStorage.setItem(ACTING_KEY, id);
  } catch {
    /* ignore */
  }
};

// A sign-in code can be exchanged only once; React's StrictMode runs effects twice in development.
let callbackOnce: Promise<User> | undefined;

export interface Session {
  user: User;
  me: Me | null;
  account: GameAccount | undefined;
  isOfficer: boolean;
  api: ReturnType<typeof createApi>;
  setActing: (playerId: string) => void;
  signOut: () => void;
  error: string | null;
  retry: () => void;
  /** Bumped whenever data changes (saves, dev tools) so views reload. */
  dataVersion: number;
  dataChanged: () => void;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

export type AuthState = { status: "loading" } | { status: "signedOut" } | { status: "signedIn"; user: User };

export function useAuth(): [AuthState, (s: AuthState) => void] {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  useEffect(() => {
    const run = async () => {
      if (window.location.pathname === "/callback") {
        callbackOnce ??= userManager().signinRedirectCallback();
        const u = await callbackOnce;
        navigate(typeof u.state === "string" ? u.state : "/", { replace: true });
        setState({ status: "signedIn", user: u });
        return;
      }
      // Restores the sign-in from storage, renewing the access token if it expired.
      const u = await currentUser();
      setState(u ? { status: "signedIn", user: u } : { status: "signedOut" });
    };
    run().catch(() => setState({ status: "signedOut" }));
  }, []);
  return [state, setState];
}

/** Access token for API calls, renewed first when it is about to expire. */
export const freshToken = async (): Promise<string | undefined> => (await currentUser())?.access_token;

export const signIn = (clientId?: string, returnTo = window.location.pathname) =>
  void startSignIn(returnTo, clientId);

export function SessionProvider({
  user,
  onSignedOut,
  children,
}: {
  user: User;
  onSignedOut: () => void;
  children: ReactNode;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [acting, setActingState] = useState<string | undefined>(readActing);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [dataVersion, setDataVersion] = useState(0);

  // The API rejected the token: forget it here and show sign-in again.
  const endSession = useCallback(() => {
    void forgetSignIn().then(onSignedOut);
  }, [onSignedOut]);

  // "Sign out" in the menu: revoke tokens and end the Cognito session too.
  const signOut = useCallback(() => {
    void signOutEverywhere().then((redirecting) => {
      if (!redirecting) onSignedOut();
    });
  }, [onSignedOut]);

  // Signing out in one tab signs out the others (they share the stored tokens).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key?.startsWith("oidc.user:") && e.newValue === null) onSignedOut();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [onSignedOut]);

  const api = useMemo(() => {
    const inner = createApi(freshToken, acting);
    // Any 401 means the session ended: go back to sign-in instead of showing errors.
    const guard =
      <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
      async (...a: A): Promise<R> => {
        try {
          return await fn(...a);
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) endSession();
          throw e;
        }
      };
    return {
      me: guard(inner.me),
      reports: guard(inner.reports),
      addReport: guard(inner.addReport),
      roster: guard(inner.roster),
      invite: guard(inner.invite),
      growth: guard(inner.growth),
      events: guard(inner.events),
      event: guard(inner.event),
      createEvent: guard(inner.createEvent),
      updateEvent: guard(inner.updateEvent),
      answer: guard(inner.answer),
    };
  }, [user, acting, endSession]);

  useEffect(() => {
    // Fetch without the acting header first: the remembered account may no longer be linked.
    createApi(freshToken)
      .me()
      .then((m) => {
        setMe(m);
        setError(null);
        setActingState((cur) =>
          cur && m.accounts.some((a) => a.playerId === cur) ? cur : m.accounts[0]?.playerId,
        );
      })
      .catch((e: Error) => {
        if (e instanceof ApiError && e.status === 401) endSession();
        else setError(e.message);
      });
  }, [user, attempt, dataVersion, endSession]);

  const setActing = useCallback((id: string) => {
    setActingState(id);
    writeActing(id);
  }, []);

  const value: Session = {
    user,
    me,
    account: me?.accounts.find((a) => a.playerId === acting),
    isOfficer: Boolean(me?.groups.includes("officer") || me?.groups.includes("owner")),
    api,
    setActing,
    signOut,
    error,
    retry: () => setAttempt((n) => n + 1),
    dataVersion,
    dataChanged: () => setDataVersion((n) => n + 1),
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
