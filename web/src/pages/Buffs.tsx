import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, type FortressBuff, type FortressBuffDetail, type FortressBuffPool } from "../api";
import { ErrorBanner } from "../components/Chrome";
import { Sheet } from "../components/Sheet";
import { useToast } from "../components/Toast";
import { dayTime, full, initials, shortDate } from "../format";
import { navigate } from "../router";
import { REWARD_DESCRIPTIONS, REWARD_IMAGES, REWARD_NAMES } from "../rewardCatalog";
import { rewardCycles, type RewardCycle } from "../rewardCycles";
import { addRewardValue, emptyRewardValue, formatRewardValue, poolRewardValue } from "../rewardValues";
import { useSession } from "../session";

const REWARD_AMOUNTS: Record<FortressBuff, number> = {
  allocatable: 40,
  speedup: 400,
  health: 60,
  hero_shard: 200,
  teleport: 90,
  damage: 60,
  deployment: 60,
  stronghold_material: 150,
  stronghold_component: 100,
  stronghold_hero_shard: 420,
  fire_crystal: 600,
};

const REWARD_GROUPS: { title: string; items: FortressBuff[] }[] = [
  { title: "Victory reward", items: ["allocatable"] },
  { title: "Fortress rewards", items: ["speedup", "health", "hero_shard", "teleport", "damage", "deployment"] },
  { title: "Stronghold rewards", items: ["stronghold_material", "stronghold_component", "stronghold_hero_shard", "fire_crystal"] },
];

const today = () => new Date().toISOString().slice(0, 10);

function gemValue(pool: Pick<FortressBuffPool, "gemValuation">, quantity = 1) {
  return formatRewardValue(addRewardValue(emptyRewardValue(), pool, quantity));
}

function valuationMidpoint(pool: Pick<FortressBuffPool, "gemValuation">) {
  return pool.gemValuation ? (pool.gemValuation.min + pool.gemValuation.max) / 2 : -1;
}

export function Buffs() {
  const { api, account, dataVersion, dataChanged } = useSession();
  const [items, setItems] = useState<FortressBuffPool[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<"inventory" | "history">("inventory");
  const [planning, setPlanning] = useState(false);
  const toast = useToast();
  const canManage = account?.rank === "R4" || account?.rank === "R5";
  const activeItems = useMemo(() => items
    ?.filter((pool) => pool.remaining > 0)
    .toSorted((a, b) => valuationMidpoint(b) - valuationMidpoint(a)) ?? [], [items]);
  const cycles = useMemo(() => rewardCycles(items ?? []), [items]);

  const buildPlan = async () => {
    setPlanning(true);
    setError(null);
    try {
      const result = await api.buildFortressRewardPlan();
      toast(result.recommendations > 0
        ? `Plan created: ${result.units} units reserved across ${result.recommendations} members and reward types`
        : "The current valued rewards are already planned");
      dataChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't build the reward plan.");
    } finally {
      setPlanning(false);
    }
  };

  useEffect(() => {
    api.fortressBuffs().then(({ items: result }) => {
      setItems(result);
      setError(null);
    }).catch((e: Error) => setError(e.message));
  }, [api, dataVersion, attempt]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Fortress rewards</h1>
          <p className="muted">Fair distribution of everything our alliance wins from Fortresses and Strongholds.</p>
        </div>
        {canManage && <div className="page-actions"><button type="button" className="btn" disabled={planning || !items?.some((item) => item.remaining > 0 && item.gemValuation)} onClick={() => void buildPlan()}>{planning ? "Building plan…" : "Build recommended plan"}</button><button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Register rewards</button></div>}
      </div>

      <section className="card buff-explainer">
        <strong>How eligibility works</strong>
        <p className="muted small">Attendance matters most, followed by Foundry strength and officer kudos. Each member can see their place; R4 and R5 can see the calculation and assign every reward type.</p>
        <div className="weight-row" aria-label="Eligibility weights">
          <span><b>60%</b> attendance</span><span><b>20%</b> strength</span><span><b>20%</b> kudos</span>
        </div>
      </section>

      {canManage && (items?.length ?? 0) > 0 && <div className="segmented reward-view-tabs" role="radiogroup" aria-label="Reward view">
        <button type="button" role="radio" aria-checked={view === "inventory"} onClick={() => setView("inventory")}>Available inventory <span>{activeItems.length}</span></button>
        <button type="button" role="radio" aria-checked={view === "history"} onClick={() => setView("history")}>Distribution history <span>{cycles.length}</span></button>
      </div>}

      {error && <ErrorBanner message={error} onRetry={() => setAttempt((n) => n + 1)} />}
      {items && view === "inventory" && cycles[0] && <CycleValueSummary cycle={cycles[0]} />}
      {!items && !error ? <div className="card skeleton" style={{ height: 220 }} /> : items?.length === 0 ? (
        <section className="card empty">
          <h2>No rewards registered</h2>
          <p className="muted">When the alliance wins officer-distributed rewards, they will appear here.</p>
          {canManage && <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Register the first reward</button>}
        </section>
      ) : canManage && view === "history" ? (
        <RewardHistory cycles={cycles} />
      ) : activeItems.length === 0 && canManage ? (
        <section className="card empty">
          <h2>No rewards waiting to be distributed</h2>
          <p className="muted">Everything registered so far has been allocated. The complete record is available under Distribution history.</p>
          <button type="button" className="btn btn-quiet" onClick={() => setView("history")}>View distribution history</button>
        </section>
      ) : (
        <div className="buff-pool-grid">
          {(canManage ? activeItems : items ?? []).map((pool) => <BuffPoolCard key={pool.poolId} pool={pool} />)}
        </div>
      )}

      <Sheet open={open} title="Register battle rewards" onClose={() => setOpen(false)}>
        <RegisterBuffForm onSave={async (input) => {
          await api.registerFortressBuffHaul(input);
          setOpen(false);
          dataChanged();
        }} />
      </Sheet>
    </>
  );
}

function CycleValueSummary({ cycle }: { cycle: RewardCycle }) {
  const total = cycle.pools.reduce((sum, pool) => addRewardValue(sum, pool, pool.quantity), emptyRewardValue());
  const distributed = cycle.pools.reduce((sum, pool) => addRewardValue(sum, pool, pool.quantity - pool.remaining), emptyRewardValue());
  const remaining = cycle.pools.reduce((sum, pool) => addRewardValue(sum, pool, pool.remaining), emptyRewardValue());
  return <section className="card reward-value-summary" aria-label="Current reward cycle value">
    <span><small>Total cycle value</small><strong>{formatRewardValue(total)}</strong></span>
    <span><small>Reserved in the plan</small><strong>{formatRewardValue(distributed)}</strong></span>
    <span><small>Not allocated yet</small><strong>{formatRewardValue(remaining)}</strong></span>
  </section>;
}

function RewardHistory({ cycles }: { cycles: RewardCycle[] }) {
  return <div className="reward-history-list">
    {cycles.map((cycle, index) => {
      const remaining = cycle.pools.reduce((sum, pool) => sum + pool.remaining, 0);
      const distributedValue = cycle.pools.reduce((sum, pool) => addRewardValue(sum, pool, pool.quantity - pool.remaining), emptyRewardValue());
      const deliveredValue = cycle.pools.reduce((sum, pool) => pool.assignments
        .filter((assignment) => assignment.status === "confirmed")
        .reduce((inner, assignment) => addRewardValue(inner, pool, assignment.amount), sum), emptyRewardValue());
      const confirmedUnits = cycle.pools.reduce((sum, pool) => sum + pool.assignments
        .filter((assignment) => assignment.status === "confirmed")
        .reduce((inner, assignment) => inner + assignment.amount, 0), 0);
      return <details key={cycle.key} className="card reward-history-cycle" open={index === 0}>
        <summary>
          <span className="reward-cycle-date"><strong>{shortDate(cycle.acquiredAt)}</strong><span className="muted small">{cycle.source}</span></span>
          <span className="reward-cycle-summary"><strong>{formatRewardValue(distributedValue)} planned</strong><span className="muted small">{formatRewardValue(deliveredValue)} confirmed · {full(confirmedUnits)} delivered units · {full(remaining)} unallocated</span></span>
          <span className="chevron" aria-hidden="true">›</span>
        </summary>
        <div className="reward-history-pools">
          {cycle.pools.map((pool) => <div key={pool.poolId} className="reward-history-pool">
            <div className="reward-history-pool-head">
              <img className="buff-game-icon" src={REWARD_IMAGES[pool.buff]} alt="" />
              <span><strong>{REWARD_NAMES[pool.buff]}</strong><span className="muted small">{full(pool.quantity - pool.remaining)} of {full(pool.quantity)} distributed</span></span>
              <span className="reward-gem-value small">{gemValue(pool, pool.quantity)}{pool.gemValuation ? " total" : ""}</span>
              <button type="button" className="text-btn" onClick={() => navigate(`/buffs/${pool.poolId}`)}>{pool.remaining > 0 ? "Assign" : "View"}</button>
            </div>
              {pool.assignments.length === 0 ? <p className="muted small reward-history-empty">No recipients yet</p> : <ul className="reward-recipient-list">
              {pool.assignments.toSorted((a, b) => Date.parse(b.assignedAt) - Date.parse(a.assignedAt)).map((assignment) => <li key={assignment.playerId}>
                <span><strong>{assignment.name}</strong><span className="muted small">{assignment.status === "confirmed" ? `Delivered · ${dayTime(assignment.confirmedAt ?? assignment.assignedAt)}` : `Recommended · ${dayTime(assignment.assignedAt)}`}</span></span>
                <span className="reward-recipient-value"><b>×{full(assignment.amount)}</b><small>{gemValue(pool, assignment.amount)}</small></span>
              </li>)}
            </ul>}
          </div>)}
        </div>
      </details>;
    })}
  </div>;
}

function BuffPoolCard({ pool }: { pool: FortressBuffPool }) {
  return (
    <button type="button" className="card buff-pool-card" onClick={() => navigate(`/buffs/${pool.poolId}`)}>
      <img className="buff-game-icon" src={REWARD_IMAGES[pool.buff]} alt="" />
      <span className="buff-pool-copy">
        <strong>{REWARD_NAMES[pool.buff]}</strong>
        <span className="muted small">{pool.source} · {shortDate(pool.acquiredAt)}</span>
        <span className="reward-gem-value small">{gemValue(pool)}{pool.gemValuation ? " each" : ""}</span>
        <span className="small">{pool.assignments.length > 0 ? `${pool.assignments.length} reserved · ${pool.assignments.filter((item) => item.status === "confirmed").length} delivered` : "Nobody allocated yet"}</span>
      </span>
      <span className="buff-remaining"><b>{pool.remaining}</b><span>of {pool.quantity} left</span></span>
      <span className="chevron" aria-hidden="true">›</span>
    </button>
  );
}

type BuffQuantities = Record<FortressBuff, number>;

const EMPTY_QUANTITIES: BuffQuantities = {
  allocatable: 0, speedup: 0, health: 0, hero_shard: 0, teleport: 0,
  damage: 0, deployment: 0, stronghold_material: 0, stronghold_component: 0,
  stronghold_hero_shard: 0, fire_crystal: 0,
};

function RegisterBuffForm({ onSave }: { onSave: (input: { quantities: BuffQuantities; source: string; acquiredAt: string }) => Promise<void> }) {
  const [quantities, setQuantities] = useState<BuffQuantities>(EMPTY_QUANTITIES);
  const [source, setSource] = useState("");
  const [acquiredAt, setAcquiredAt] = useState(today);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave({ quantities, source, acquiredAt });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't register these rewards.");
    } finally {
      setSaving(false);
    }
  };

  const total = Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0);
  const setQuantity = (buff: FortressBuff, raw: number) => {
    const quantity = Number.isFinite(raw) ? Math.max(0, Math.min(10_000, Math.trunc(raw))) : 0;
    setQuantities((current) => ({ ...current, [buff]: quantity }));
  };

  return (
    <form className="stack" onSubmit={(event) => void submit(event)}>
      <p className="muted small">Tap the pictured amount for every reward POP won. Leave the rest at zero; every amount remains editable.</p>
      {REWARD_GROUPS.map((group) => <fieldset key={group.title} className="reward-group">
        <legend>{group.title}</legend>
        <div className="buff-quantity-grid">
          {group.items.map((buff) => (
            <div key={buff} className={`buff-quantity buff-quantity-${buff}`}>
              <img className="buff-game-icon" src={REWARD_IMAGES[buff]} alt="" />
              <div className="buff-quantity-copy">
                <label htmlFor={`buff-${buff}`}><strong>{REWARD_NAMES[buff]}</strong></label>
                {REWARD_DESCRIPTIONS[buff] && <span className="muted small">{REWARD_DESCRIPTIONS[buff]}</span>}
                <button type="button" className="text-btn buff-preset" onClick={() => setQuantity(buff, REWARD_AMOUNTS[buff])}>Use {REWARD_AMOUNTS[buff]}</button>
              </div>
              <div className="quantity-stepper">
                <button type="button" aria-label={`Remove one ${REWARD_NAMES[buff]}`} disabled={quantities[buff] === 0} onClick={() => setQuantity(buff, quantities[buff] - 1)}>−</button>
                <input id={`buff-${buff}`} type="number" min="0" max="10000" inputMode="numeric" value={quantities[buff]} onChange={(e) => setQuantity(buff, Number(e.target.value))} />
                <button type="button" aria-label={`Add one ${REWARD_NAMES[buff]}`} onClick={() => setQuantity(buff, quantities[buff] + 1)}>+</button>
              </div>
            </div>
          ))}
        </div>
      </fieldset>)}
      <div className="buff-haul-total"><span>Total reward units</span><strong>{total}</strong></div>
      <div className="form-grid">
        <label className="field"><span>Source</span><input required maxLength={60} placeholder="Week 3 Fortress rewards" value={source} onChange={(e) => setSource(e.target.value)} /></label>
        <label className="field"><span>Date received</span><input type="date" required value={acquiredAt} onChange={(e) => setAcquiredAt(e.target.value)} /></label>
      </div>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary btn-block" disabled={saving || total === 0}>{saving ? "Registering…" : total === 0 ? "Choose at least one reward" : `Register ${total} reward units`}</button>
    </form>
  );
}

export function BuffDetail({ poolId }: { poolId: string }) {
  const { api, account, dataVersion, dataChanged } = useSession();
  const [pool, setPool] = useState<FortressBuffDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [attempt, setAttempt] = useState(0);
  const toast = useToast();
  const canManage = account?.rank === "R4" || account?.rank === "R5";

  useEffect(() => {
    api.fortressBuff(poolId).then((result) => {
      setPool(result);
      setError(null);
    }).catch((e: Error) => setError(e.message));
  }, [api, poolId, dataVersion, attempt]);

  const assign = async (playerId: string, name: string) => {
    const candidate = pool?.candidates.find((item) => item.playerId === playerId);
    const amount = Math.max(1, Math.min(pool?.remaining ?? 1, amounts[playerId] ?? candidate?.recommendedAmount ?? 1));
    setAssigning(playerId);
    setError(null);
    try {
      await api.assignFortressBuff(poolId, playerId, amount);
      toast(`${amount} reward ${amount === 1 ? "unit" : "units"} reserved for ${name}`);
      dataChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't assign this reward.");
    } finally {
      setAssigning(null);
    }
  };

  const confirmDelivery = async (playerId: string, name: string) => {
    setConfirming(playerId);
    setError(null);
    try {
      await api.confirmFortressBuffAssignment(poolId, playerId);
      toast(`${name}'s reward marked as delivered`);
      dataChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't confirm this delivery.");
    } finally {
      setConfirming(null);
    }
  };

  if (error && !pool) return <><button type="button" className="back-link" onClick={() => navigate("/buffs")}>← Rewards</button><ErrorBanner message={error} onRetry={() => setAttempt((n) => n + 1)} /></>;
  if (!pool) return <div className="card skeleton" style={{ height: 320 }} />;
  const unitValue = poolRewardValue(pool, 1);

  return (
    <>
      <button type="button" className="back-link" onClick={() => navigate("/buffs")}>← Rewards</button>
      <div className="page-head buff-detail-head">
        <div><h1 className="page-title">{REWARD_NAMES[pool.buff]}</h1><p className="muted">{pool.source} · received {shortDate(pool.acquiredAt)}</p>{REWARD_DESCRIPTIONS[pool.buff] && <p className="muted small">{REWARD_DESCRIPTIONS[pool.buff]}</p>}<p className="reward-gem-value small">{gemValue(pool)}{pool.gemValuation ? ` per unit · ${pool.gemValuation.confidence} confidence` : " · officer value needed"}</p></div>
        <span className="buff-stock"><b>{pool.remaining}</b> of {pool.quantity} available</span>
      </div>
      {error && <ErrorBanner message={error} onRetry={() => setAttempt((n) => n + 1)} />}

      {pool.assignments.length > 0 && <section className="card"><h2>Allocation plan</h2><div className="buff-assigned-list">{pool.assignments.map((item) => <div key={item.playerId} className="reward-plan-row"><span><strong>{item.name} ×{item.amount}</strong><small>{gemValue(pool, item.amount)} · {item.status === "confirmed" ? "delivered" : "recommended and reserved"}</small></span>{canManage && item.status === "recommended" && <button type="button" className="btn btn-small" disabled={confirming !== null} onClick={() => void confirmDelivery(item.playerId, item.name)}>{confirming === item.playerId ? "Confirming…" : "Confirm delivered"}</button>}</div>)}</div></section>}

      <section className="card buff-ranking-card">
        <div className="section-head"><div><h2>Eligibility ranking</h2><p className="muted small">The top {Math.min(40, pool.candidates.length)} members are currently eligible. Reward units can be split between them. Higher-value rewards are shown first in inventory so officers can start with the highest-ranked members.</p></div></div>
        {pool.candidates.length === 0 ? <p className="muted">Everyone has been assigned, or there are no active members.</p> : <ol className="buff-ranking">
          {pool.candidates.map((candidate) => (
            <li key={candidate.playerId} className={candidate.eligible ? "buff-candidate buff-candidate-eligible" : "buff-candidate"}>
              <span className="growth-rank">{candidate.position}</span>
              <span className="avatar" aria-hidden="true">{initials(candidate.name)}</span>
              <span className="member-text"><strong>{candidate.name}</strong><span className="muted small">{candidate.eligible ? "Eligible now" : "Waiting list"}</span></span>
              {candidate.score !== undefined && <div className="buff-score" aria-label={`Eligibility score ${Math.round(candidate.score * 100)} percent`}><strong>{Math.round(candidate.score * 100)}%</strong><span className="muted small">Attendance {Math.round((candidate.participationRate ?? 0) * 100)}% · Strength {full(candidate.strength ?? 0)} · Kudos {Math.round((candidate.kudosShare ?? 0) * 100)}%</span></div>}
              <div className="candidate-cycle-value"><strong>{candidate.cycleRewardValueMin === 0 && candidate.cycleRewardValueMax === 0 && candidate.cycleUnvaluedUnits === 0 ? "None yet" : formatRewardValue({ min: candidate.cycleRewardValueMin, max: candidate.cycleRewardValueMax, unvaluedUnits: candidate.cycleUnvaluedUnits })}</strong><span className="muted small">already assigned this cycle{pool.gemValuation ? ` · this reward ${formatRewardValue(unitValue)} each` : ""}</span></div>
              <div className="candidate-target"><span className="muted small">Cycle target</span><strong>{formatRewardValue({ min: candidate.cycleTargetValueMin, max: candidate.cycleTargetValueMax, unvaluedUnits: 0 })}</strong>{candidate.recommendedAmount > 0 && <span className="reward-recommendation">Suggested here: ×{candidate.recommendedAmount}</span>}</div>
              {canManage && candidate.eligible && pool.remaining > 0 && <div className="reward-assign-control"><input type="number" min="1" max={pool.remaining} inputMode="numeric" aria-label={`Amount for ${candidate.name}`} value={amounts[candidate.playerId] ?? Math.max(1, candidate.recommendedAmount)} onChange={(event) => setAmounts((current) => ({ ...current, [candidate.playerId]: Math.max(1, Math.min(pool.remaining, Number(event.target.value) || 1)) }))} /><button type="button" className="btn btn-primary btn-small" disabled={assigning !== null} onClick={() => void assign(candidate.playerId, candidate.name)}>{assigning === candidate.playerId ? "Assigning…" : "Assign"}</button></div>}
            </li>
          ))}
        </ol>}
      </section>
    </>
  );
}
