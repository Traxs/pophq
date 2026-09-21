import { AgentTokens } from "../components/AgentTokens";
import { initials } from "../format";
import { ACCOUNTS_SECTION, canManageBots } from "../settings";
import { useSession } from "../session";

/**
 * Settings: the app's own knobs, away from alliance data. Bot tokens live here rather than at the
 * foot of the Members table, where they sat next to the roster and read like member data.
 */
export function Settings() {
  const { me, account, setActing, signOut } = useSession();
  const groups = me?.groups ?? [];

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Settings</h1>
      </div>

      <section className="card stack" aria-labelledby="accounts-title">
        <div>
          <h2 id="accounts-title" className="section-label">
            {ACCOUNTS_SECTION.title}
          </h2>
          <p className="muted small">{ACCOUNTS_SECTION.blurb}</p>
        </div>
        <ul className="account-list">
          {me?.accounts.map((a) => (
            <li key={a.playerId}>
              <button
                type="button"
                className="account-row"
                aria-current={a.playerId === account?.playerId}
                onClick={() => setActing(a.playerId)}
              >
                <span className="avatar" aria-hidden="true">
                  {initials(a.name)}
                </span>
                <span className="account-row-text">
                  <strong>{a.name}</strong>
                  <span className="muted">
                    {a.playerId} · {a.alliance}
                    {a.rank ? ` · ${a.rank}` : ""}
                  </span>
                </span>
                {a.playerId === account?.playerId && <span className="pill pill-flat">In use</span>}
              </button>
            </li>
          ))}
        </ul>
        {me?.accounts.length === 0 && (
          <p className="muted">No game account yet. An officer links yours once they have checked your Player ID.</p>
        )}
      </section>

      {/* The panel carries its own explanation, so the section blurb is not repeated here. */}
      {canManageBots(groups) && <AgentTokens />}

      <button type="button" className="btn btn-quiet btn-block" onClick={signOut}>
        Sign out
      </button>
    </>
  );
}
