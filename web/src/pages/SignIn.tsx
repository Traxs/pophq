import { DEV_PERSONAS } from "../auth";
import { initials } from "../format";
import { signIn } from "../session";

export function SignIn() {
  return (
    <main className="signin">
      <div className="signin-card">
        <span className="signin-mark" aria-hidden="true">
          ❄
        </span>
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
          <>
            <button type="button" className="btn btn-primary btn-block" onClick={() => signIn()}>
              Sign in
            </button>
            <p className="muted small">
              Use the email address or temporary login name provided by an officer.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
