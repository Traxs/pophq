import type { CurrentRewardCycle } from "../api";
import { dayTime, full } from "../format";
import { REWARD_IMAGES, REWARD_NAMES } from "../rewardCatalog";
import { addRewardValue, assignmentRewardValue, emptyRewardValue, formatRewardValue } from "../rewardValues";

export function MemberRewardCards({ cycle, onAllRewards }: { cycle: CurrentRewardCycle; onAllRewards: () => void }) {
  const visible = cycle.items
    .toSorted((a, b) => {
      const aValue = a.pool.gemValuation ? (a.pool.gemValuation.min + a.pool.gemValuation.max) / 2 : -1;
      const bValue = b.pool.gemValuation ? (b.pool.gemValuation.min + b.pool.gemValuation.max) / 2 : -1;
      return bValue - aValue || b.assignedAt.localeCompare(a.assignedAt);
    })
    .slice(0, 4);
  const confirmed = cycle.items.filter((item) => item.status === "confirmed").length;
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  const points = (value: number, weight: number) => `${Number((value * weight * 100).toFixed(1))} pts`;
  const cycleValue = cycle.items.reduce((sum, item) => addRewardValue(sum, item.pool, item.amount), emptyRewardValue());

  return <section className="stack" aria-labelledby="your-rewards-title">
    <div className="section-head home-reward-section-head">
      <div><h2 id="your-rewards-title" className="section-label">Your reward plan</h2><p className="muted small">Recommended and reserved from {cycle.source}. Your current allocation: <strong>{formatRewardValue(cycleValue)}</strong>. {confirmed > 0 ? `${confirmed} confirmed delivered.` : "Nothing is confirmed delivered yet."}</p></div>
      <button type="button" className="text-btn" onClick={onAllRewards}>All rewards</button>
    </div>
    <div className="home-reward-list">{visible.map((item) => {
      const eligibility = item.eligibility;
      return <article key={`${item.poolId}:${item.playerId}`} className="card home-reward-card">
        <div className="home-reward-head">
          <img className="buff-game-icon" src={REWARD_IMAGES[item.pool.buff]} alt="" />
          <span className="home-reward-title"><strong>{REWARD_NAMES[item.pool.buff]}</strong><span className="muted small">{item.status === "confirmed" ? `Delivered · confirmed ${dayTime(item.confirmedAt ?? item.assignedAt)}` : `Recommended · reserved ${dayTime(item.assignedAt)}`}</span></span>
          <span className="home-reward-amount">×{full(item.amount)}<small>{formatRewardValue(assignmentRewardValue(item))}</small></span>
        </div>
        <details className="home-reward-why">
          <summary>Why this reward is recommended for you</summary>
          {eligibility ? <div className="home-reward-explanation">
            <p><strong>Place #{eligibility.position}</strong> · eligible places were 1–{eligibility.eligibleThrough} · total score {percent(eligibility.score)}</p>
            <div className="reward-score-parts">
              <span><b>{percent(eligibility.participationRate)}</b><small>Participation × {percent(eligibility.weights.participation)} = {points(eligibility.participationRate, eligibility.weights.participation)}</small></span>
              <span><b>{percent(eligibility.strengthShare)}</b><small>Strength × {percent(eligibility.weights.strength)} = {points(eligibility.strengthShare, eligibility.weights.strength)}</small></span>
              <span><b>{percent(eligibility.kudosShare)}</b><small>Kudos × {percent(eligibility.weights.kudos)} = {points(eligibility.kudosShare, eligibility.weights.kudos)}</small></span>
            </div>
            <p className="muted small">Foundry strength used: {full(eligibility.strength)} of the highest {full(eligibility.strongestStrength)}. The calculation was saved when the reward was assigned, so later changes do not rewrite this explanation.</p>
          </div> : <p className="muted small home-reward-legacy">This assignment predates saved eligibility explanations.</p>}
        </details>
      </article>;
    })}</div>
  </section>;
}
