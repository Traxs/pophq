import { useState, type FormEvent } from "react";
import { DEV_PERSONAS } from "../auth";
import { initials } from "../format";
import { cognitoLoginIdentifier } from "../loginNames";
import { signIn } from "../session";

export function SignIn() {
  const [login, setLogin] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (login.trim()) void signIn(undefined, "/", cognitoLoginIdentifier(login));
  };
  return (
    <main className="signin">
      <div className="signin-card">
        <img className="signin-logo" src="/pop-logo.png" alt="" aria-hidden="true" />
        <h1>POP HQ</h1>
        <p className="muted">The POP alliance's command center for State 2612.</p>

        {import.meta.env.DEV && DEV_PERSONAS.length > 0 ? (
          <section className="personas" aria-labelledby="personas-title">
            <h2 id="personas-title" className="section-label">
              Local test sign-in
            </h2>
            <ul>
              {DEV_PERSONAS.map((p) => (
                <li key={p.clientId}>
                  <button type="button" className="persona" onClick={() => signIn(p.clientId, "/")}>
                    <span className="avatar" aria-hidden="true">
                      {initials(p.name)}
                    </span>
                    <span className="persona-text">
                      <strong>{p.name}</strong>
                      <span className="muted small">
                        {p.role} · {p.description}
                      </span>
                    </span>
                    <span className="chevron" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="muted small">Fake people and data from the local demo set. Not shown in production.</p>
          </section>
        ) : (
          <form className="signin-form" onSubmit={submit}>
            <label htmlFor="signin-login">Email or login name</label>
            <input id="signin-login" value={login} onChange={(event) => setLogin(event.target.value)} autoComplete="username" autoCapitalize="none" placeholder="e.g. aoife" required />
            <button type="submit" className="btn btn-primary btn-block" disabled={!login.trim()}>
              Sign in
            </button>
            <p className="muted small">
              Use your email address or the login name you chose when joining.
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
