import type { HomePriorityCandidate } from "../homePriority";

export function HomePriorities({ candidates, loading, onOpen }: { candidates: readonly HomePriorityCandidate[]; loading: boolean; onOpen: (href: string) => void }) {
  if (loading) return <section className="home-priority-shell" aria-label="Loading what needs your attention" aria-busy="true">
    <div className="home-priority-loading skeleton" />
  </section>;

  const attention = candidates.filter((candidate) => candidate.section === "attention");
  const upcoming = candidates.filter((candidate) => candidate.section === "upcoming").slice(0, 4);
  const primary = attention[0];
  const next = attention.slice(1, 3);

  return <section className="home-priority-shell" aria-labelledby="right-now-title">
    <div className="home-priority-heading"><h2 id="right-now-title" className="section-label">Right now</h2>{attention.length > 1 && <span>{attention.length} things need attention</span>}</div>
    {primary ? <button type="button" className={`home-priority-hero card priority-tier-${primary.tier}`} onClick={() => onOpen(primary.href)}>
      <span className="home-priority-icon" aria-hidden="true">{primary.icon}</span>
      <span className="home-priority-copy"><strong>{primary.title}</strong><span>{primary.detail}</span></span>
      {primary.actionLabel && <span className="home-priority-action">{primary.actionLabel}</span>}
      <span className="chevron" aria-hidden="true">›</span>
    </button> : <div className="home-priority-clear card">
      <span className="home-priority-icon" aria-hidden="true">✓</span>
      <span><strong>You’re all caught up</strong><small>{upcoming.length ? "Nothing needs action right now." : "No actions or appointments are waiting."}</small></span>
    </div>}

    {next.length > 0 && <div className="home-priority-next" aria-label="Next actions">
      {next.map((candidate) => <button key={candidate.id} type="button" className="home-priority-next-row" onClick={() => onOpen(candidate.href)}>
        <span className={`home-priority-dot priority-tier-${candidate.tier}`} aria-hidden="true">{candidate.icon}</span>
        <span><strong>{candidate.title}</strong><small>{candidate.detail}</small></span>
        <span className="chevron" aria-hidden="true">›</span>
      </button>)}
    </div>}

    {upcoming.length > 0 && <div className="home-coming-up">
      <h3 className="section-label">Coming up</h3>
      <div className="home-coming-list">{upcoming.map((candidate) => <button key={candidate.id} type="button" onClick={() => onOpen(candidate.href)}>
        <span className="home-coming-icon" aria-hidden="true">{candidate.icon}</span>
        <span><strong>{candidate.title}</strong><small>{candidate.detail}</small></span>
        <span className="chevron" aria-hidden="true">›</span>
      </button>)}</div>
    </div>}
  </section>;
}
