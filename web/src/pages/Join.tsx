import { useEffect, useState, type FormEvent } from "react";
import { ApiError, inspectOnboardingInvitation, redeemOnboardingInvitation, type PublicOnboardingInvitation, type RedeemedOnboardingInvitation } from "../api";
import { isValidEmail } from "../rules";
import { signIn } from "../session";

type Method = "email" | "password";

// Fragments never reach CloudFront or the API. Capture once, then remove the bearer secret from
// browser history/address-bar state before making any network request.
let capturedToken: string | undefined;
if (window.location.pathname === "/join" && window.location.hash.length > 1) {
  capturedToken = window.location.hash.slice(1);
  window.history.replaceState(window.history.state, "", "/join");
}

const loginNameValid = (value: string) => /^[a-z0-9](?:[a-z0-9._-]{1,22}[a-z0-9])?$/.test(value.trim().toLowerCase());

export function Join() {
  const [invitation, setInvitation] = useState<PublicOnboardingInvitation>();
  const [method, setMethod] = useState<Method>("email");
  const [email, setEmail] = useState("");
  const [loginName, setLoginName] = useState("");
  const [result, setResult] = useState<RedeemedOnboardingInvitation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!capturedToken) {
      setError("This invitation is missing, expired, or has already been used. Ask an R4 for a new link.");
      return;
    }
    inspectOnboardingInvitation(capturedToken)
      .then((value) => {
        setInvitation(value);
        setLoginName(value.playerName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 24));
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "This invitation could not be checked."));
  }, []);

  const ready = method === "email" ? isValidEmail(email) : loginNameValid(loginName);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!capturedToken || !ready || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const redeemed = await redeemOnboardingInvitation(
        capturedToken,
        method === "email"
          ? { method, email: email.trim().toLowerCase() }
          : { method, loginName: loginName.trim().toLowerCase() },
      );
      capturedToken = undefined;
      setResult(redeemed);
    } catch (err) {
      capturedToken = undefined; // a redemption attempt consumes the invitation, including failures
      setError(err instanceof ApiError ? err.message : "Access could not be created. Ask an R4 for a new invitation.");
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const credentialText = result.credentials
      ? `POP HQ\nLogin: ${result.credentials.username}\nTemporary password: ${result.credentials.password}`
      : "";
    return <main className="signin join-page">
      <section className="signin-card join-card" aria-labelledby="join-ready-title">
        <img className="signin-logo" src="/pop-logo.png" alt="" aria-hidden="true" />
        <div className="success-mark" aria-hidden="true">✓</div>
        <h1 id="join-ready-title">Your POP HQ access is ready</h1>
        {result.method === "email" ? <>
          <p>A secure sign-in code will be sent to <strong>{result.signInIdentifier}</strong>.</p>
          <button className="btn btn-primary btn-block" type="button" onClick={() => signIn(undefined, "/", result.signInIdentifier)}>
            Continue to sign in
          </button>
        </> : <>
          <p className="muted">Use this temporary credential once. Cognito will require you to choose a private password that meets the POP HQ password policy.</p>
          <Credential label="Login name" value={result.credentials!.username} />
          <Credential label="Temporary password" value={result.credentials!.password} />
          <button className="btn btn-quiet btn-block" type="button" onClick={() => void navigator.clipboard.writeText(credentialText).then(() => setCopied(true))}>
            {copied ? "Copied" : "Copy temporary login"}
          </button>
          <button className="btn btn-primary btn-block" type="button" onClick={() => signIn(undefined, "/", result.signInIdentifier)}>
            Continue and choose my password
          </button>
          <p className="banner banner-warn small">This temporary password is shown only once. Do not share it with anyone.</p>
        </>}
      </section>
    </main>;
  }

  return <main className="signin join-page">
    <section className="signin-card join-card" aria-labelledby="join-title">
      <img className="signin-logo" src="/pop-logo.png" alt="" aria-hidden="true" />
      <span className="section-label">Private alliance invitation</span>
      <h1 id="join-title">Join POP HQ</h1>
      {!invitation && !error && <div className="join-loading" aria-busy="true"><span className="spinner" />Checking your invitation…</div>}
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      {invitation && !error && <form className="form" onSubmit={submit} noValidate>
        <div className="join-player">
          <strong>{invitation.playerName}</strong>
          <span className="muted small">Player ID {invitation.playerId}</span>
          <span className="muted small">Invitation expires {new Date(invitation.expiresAt).toLocaleString()}</span>
        </div>
        <fieldset className="field">
          <legend>How would you like to sign in?</legend>
          <div className="join-methods">
            <button type="button" className={method === "email" ? "selected" : ""} aria-pressed={method === "email"} onClick={() => setMethod("email")}>
              <strong>Email code</strong><span>No password to remember</span>
            </button>
            <button type="button" className={method === "password" ? "selected" : ""} aria-pressed={method === "password"} onClick={() => setMethod("password")}>
              <strong>Login & password</strong><span>No email required</span>
            </button>
          </div>
        </fieldset>
        {method === "email" ? <div className="field">
          <label htmlFor="join-email">Your email</label>
          <input id="join-email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
          <span className="hint">Cognito sends a fresh one-time code whenever you sign in.</span>
        </div> : <div className="field">
          <label htmlFor="join-name">Choose your login name</label>
          <div className="login-name-input"><input id="join-name" autoComplete="username" autoCapitalize="none" value={loginName} onChange={(event) => setLoginName(event.target.value.toLowerCase())} /><span>@members.pophq.invalid</span></div>
          <span className="hint">3–24 letters, numbers, dots, dashes or underscores. Cognito asks you to choose your private password next.</span>
        </div>}
        <button className="btn btn-primary btn-block" type="submit" disabled={!ready || busy}>{busy ? "Creating secure access…" : "Create my access"}</button>
        <p className="muted small center">This invitation works once and expires after 24 hours.</p>
      </form>}
    </section>
  </main>;
}

function Credential({ label, value }: { label: string; value: string }) {
  return <div className="credential-row"><span><small>{label}</small><code>{value}</code></span></div>;
}
