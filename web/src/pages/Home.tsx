import { change, compact, daysBetween, relativeDay } from "../format";
import { navigate } from "../router";
import { REPORT_DUE_DAYS } from "../rules";
import { useSession } from "../session";
import { usePower } from "../usePower";
import { ChangePill } from "./Power";


export function Home() {
  const { me, account } = useSession();
  const { latest, previous, loading } = usePower();

  if (me && me.accounts.length === 0) return <NoAccount />;

  const age = latest ? daysBetween(new Date(latest.effectiveAt), new Date()) : undefined;
  const due = age === undefined || age >= REPORT_DUE_DAYS;
  const delta = latest ? change(latest.power, previous?.power) : undefined;

  return (
    <>
      <h1 className="page-title">{account ? `Hi, ${account.name}` : " "}</h1>

      <section aria-labelledby="todo-title" className="stack">
        <h2 id="todo-title" className="section-label">
          To do
        </h2>
        {loading && !latest ? (
          <div className="card skeleton" style={{ height: 88 }} />
        ) : due ? (
          <button type="button" className="card todo todo-due" onClick={() => navigate("/power?update=1")}>
            <span className="todo-icon" aria-hidden="true">
              !
            </span>
            <span className="todo-text">
              <strong>{latest ? "Power report due" : "Submit your first power report"}</strong>
              <span className="muted">
                {latest ? `Last one was ${relativeDay(latest.effectiveAt)}.` : "Takes 30 seconds."}
              </span>
            </span>
            <span className="chevron" aria-hidden="true">
              ›
            </span>
          </button>
        ) : (
          <div className="card todo todo-done">
            <span className="todo-icon" aria-hidden="true">
              ✓
            </span>
            <span className="todo-text">
              <strong>Power report up to date</strong>
              <span className="muted">
                Last one {relativeDay(latest!.effectiveAt)}. Next due in {REPORT_DUE_DAYS - (age ?? 0)} days.
              </span>
            </span>
          </div>
        )}
      </section>

      {latest && (
        <button type="button" className="card summary" onClick={() => navigate("/power")}>
          <span className="summary-label">Power</span>
          <span className="summary-value">{compact(latest.power)}</span>
          {delta && <ChangePill change={delta} since={previous!.effectiveAt} />}
        </button>
      )}

      <p className="muted small center">SvS buff slots, events and lineups arrive here in the next updates.</p>
    </>
  );
}

/** Shown to a signed-in person whose game account an officer hasn't linked yet. */
export function NoAccount() {
  return (
    <section className="card empty">
      <h2>No game account linked yet</h2>
      <p className="muted">
        An officer links your game account after checking your Player ID. You'll see your power and events here once
        that's done.
      </p>
    </section>
  );
}
