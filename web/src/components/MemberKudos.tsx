import type { KudosAwardView, KudosSummary, RewardEligibility } from "../api";
import { formatRewardValue } from "../rewardValues";

const signed = (value: number, digits = 1) => {
  const rounded = Number(value.toFixed(digits));
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString(undefined, { maximumFractionDigits: digits })}`;
};

const date = (value: string) => new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
}).format(new Date(value));

function Award({ award }: { award: KudosAwardView }) {
  const correction = award.points < 0;
  return <li className={`kudos-award${correction ? " kudos-correction" : ""}`}>
    <div className="kudos-award-head">
      <span>
        <strong>{award.reason}</strong>
        <small className="muted">Awarded {date(award.awardedAt)}</small>
      </span>
      <span className="kudos-award-value">
        <b>{signed(award.currentPoints)}</b>
        <small>of {signed(award.points, 0)}</small>
      </span>
    </div>
    {award.active ? <>
      <progress value={award.remainingShare} max={1} aria-label={`${Math.round(award.remainingShare * 100)}% of this kudos award remains`} />
      <p className="muted small">
        {Math.round(award.remainingShare * 100)}% remains · {award.daysRemaining} {award.daysRemaining === 1 ? "day" : "days"} until it contributes 0
      </p>
    </> : <p className="muted small">Expired {date(award.expiresAt)} · contributes 0</p>}
  </li>;
}

export function MemberKudosCard({ summary, eligibility }: { summary: KudosSummary; eligibility: RewardEligibility }) {
  const active = summary.items.filter((award) => award.active);
  const expired = summary.items.filter((award) => !award.active);
  const percent = (value: number) => `${Number((value * 100).toFixed(1))}%`;
  const points = (value: number) => Number(value.toFixed(1));
  const participationPoints = points(eligibility.participationRate * eligibility.weights.participation * 100);
  const strengthPoints = points(eligibility.strengthShare * eligibility.weights.strength * 100);
  const kudosPoints = points(eligibility.kudosShare * eligibility.weights.kudos * 100);
  const totalPoints = points(eligibility.score * 100);
  const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 1 });

  return <section className="card kudos-card" aria-labelledby="reward-eligibility-title">
    <div className="eligibility-head">
      <span>
        <h2 id="reward-eligibility-title" className="section-label">Fortress reward eligibility</h2>
        <span className="muted small">Your live position before an R4 assigns available rewards</span>
      </span>
      <span className={eligibility.eligible ? "eligibility-status eligible" : "eligibility-status waiting"}>
        {eligibility.eligible ? "Eligible now" : "Waiting list"}
      </span>
    </div>

    <div className="eligibility-place">
      <strong>#{eligibility.position}</strong>
      <span>of {eligibility.totalMembers} active members</span>
      <b>Top {eligibility.eligibleThrough} are eligible</b>
    </div>

    {eligibility.allocation && <div className="eligibility-allocation">
      <span><small>Your score-weighted target this cycle</small><strong>{formatRewardValue({ min: eligibility.allocation.targetValueMin, max: eligibility.allocation.targetValueMax, unvaluedUnits: 0 })}</strong></span>
      <span><small>Assigned to you so far</small><strong>{formatRewardValue({ min: eligibility.allocation.assignedValueMin, max: eligibility.allocation.assignedValueMax, unvaluedUnits: eligibility.allocation.assignedUnvaluedUnits })}</strong></span>
      <p className="muted small">Higher-ranked members receive a larger value target and priority for the strongest rewards. Smaller divisible rewards fill the remaining gap.</p>
    </div>}

    <div className="eligibility-calculation" aria-label={`Overall eligibility score ${totalPoints} out of 100 points`}>
      <div className="eligibility-total"><strong>Overall score</strong><b>{totalPoints} <small>/ 100 pts</small></b></div>
      <details className="eligibility-part">
        <summary className="eligibility-part-summary"><span><b>Participation</b><small>Input {percent(eligibility.participationRate)} · worth up to {eligibility.weights.participation * 100} pts</small></span><strong>{participationPoints} pts</strong><i aria-hidden="true">›</i></summary>
        <div className="eligibility-part-details">
          <p><b>{percent(eligibility.participationRate)}</b> participation × <b>{eligibility.weights.participation * 100}</b> available points = <strong>{participationPoints} points</strong>.</p>
          <p className="muted small">This uses recent alliance events. Attendance earns full credit, a signed-up no-show counts twice against the rate, and not registering counts half. Excused or unchecked events do not count.</p>
        </div>
      </details>
      <details className="eligibility-part">
        <summary className="eligibility-part-summary"><span><b>Foundry strength</b><small>Input {percent(eligibility.strengthShare)} · worth up to {eligibility.weights.strength * 100} pts</small></span><strong>{strengthPoints} pts</strong><i aria-hidden="true">›</i></summary>
        <div className="eligibility-part-details">
          <p><b>{number(eligibility.strength)}</b> your strength ÷ <b>{number(eligibility.strongestStrength)}</b> alliance highest = <b>{percent(eligibility.strengthShare)}</b>.</p>
          <p>{percent(eligibility.strengthShare)} × <b>{eligibility.weights.strength * 100}</b> available points = <strong>{strengthPoints} points</strong>.</p>
        </div>
      </details>
      <details className="eligibility-part">
        <summary className="eligibility-part-summary"><span><b>Kudos</b><small>Input {percent(eligibility.kudosShare)} · current bonus {signed(eligibility.kudosScore)}</small></span><strong>{kudosPoints} pts</strong><i aria-hidden="true">›</i></summary>
        <div className="eligibility-part-details kudos-details">
          <p><b>{signed(eligibility.kudosScore)}</b> your current Kudos ÷ <b>{signed(eligibility.bestKudosScore)}</b> alliance best = <b>{percent(eligibility.kudosShare)}</b>.</p>
          <p>{percent(eligibility.kudosShare)} × <b>{eligibility.weights.kudos * 100}</b> available points = <strong>{kudosPoints} points</strong>.</p>
          <div className="kudos-summary">
            <span><h3>Your kudos awards</h3><span className="muted small">Recognition for contributions that event numbers cannot show</span></span>
            <strong className={summary.score < 0 ? "delta-down" : ""}>{signed(summary.score)}</strong>
          </div>
          <div className="kudos-rule">
            <strong>How Kudos decay</strong>
            <p>Each award starts at its full value and decreases evenly to zero over {summary.decayDays} days.</p>
          </div>
          {active.length > 0 ? <ul className="kudos-awards">{active.map((award) => <Award key={award.awardId} award={award} />)}</ul> : <p className="muted kudos-empty">No kudos currently contributes to your score.</p>}
          {expired.length > 0 && <details className="kudos-history">
            <summary>Expired history ({expired.length})</summary>
            <ul className="kudos-awards">{expired.map((award) => <Award key={award.awardId} award={award} />)}</ul>
          </details>}
        </div>
      </details>
      <div className="eligibility-equation">{participationPoints} + {strengthPoints} + {kudosPoints} = <strong>{totalPoints} pts</strong></div>
    </div>

    <p className="muted small eligibility-note">Eligibility means an R4 can select you while inventory is available. Recommendations follow the current ranking, but the R4 makes the final assignment and can override them.</p>
  </section>;
}
