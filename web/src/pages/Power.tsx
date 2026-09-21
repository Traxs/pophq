import { useEffect, useState, type FormEvent } from "react";
import { ApiError, type Reports } from "../api";
import { ErrorBanner } from "../components/Chrome";
import { Sheet } from "../components/Sheet";
import { LineChart } from "../components/LineChart";
import { useToast } from "../components/Toast";
import { change, full, formatDigitsInput, parseDigits, relativeDay, shortDate, type Change } from "../format";
import { navigate } from "../router";
import { LEVEL_HINT, isValidLevel } from "../rules";
import { useSession } from "../session";
import { troopDraftFrom, troopValues, TROOP_LABELS, TROOP_TYPES } from "../troops";
import { usePower, type PowerPoint } from "../usePower";
import { NoAccount } from "./Home";


const DROP_WARNING = 0.2; // PWR-01: confirm a drop of more than 20%

const SOURCE_LABEL: Record<string, string> = {
  player: "You",
  officer: "Officer",
  import: "Imported",
  hermes: "Hermes",
};

export function ChangePill({ change: c, since }: { change: Change; since: string }) {
  const sign = c.direction === "up" ? "+" : c.direction === "down" ? "−" : "±";
  return (
    <span className={`pill pill-${c.direction}`}>
      {sign}
      {Math.abs(c.percent).toFixed(1)}% since {shortDate(since)}
    </span>
  );
}

export function Power() {
  const { account } = useSession();
  const power = usePower();
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).has("update"));

  // Deep link /power?update=1 opens the sheet once, then cleans the URL.
  useEffect(() => {
    if (window.location.search) navigate("/power", { replace: true });
  }, []);

  if (!account) return <NoAccount />;
  const { reports, series, latest, previous, loading, error, reload } = power;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Power</h1>
        <span className="muted">{account.name}</span>
      </div>

      {error && <ErrorBanner message={error} onRetry={reload} />}

      {loading && !reports ? (
        <div className="card skeleton" style={{ height: 196 }} />
      ) : latest ? (
        <HeroCard latest={latest} previous={previous} series={series} />
      ) : (
        <section className="card empty">
          <h2>No power reports yet</h2>
          <p className="muted">Your first report starts your history and growth chart.</p>
        </section>
      )}

      {reports && <OtherStats current={reports.current} />}

      <div className="sticky-action">
        <button type="button" className="btn btn-primary btn-block" onClick={() => setOpen(true)}>
          {latest ? "Update power" : "Submit first report"}
        </button>
      </div>

      {series.length > 0 && <History series={series} />}

      <Sheet open={open} title="Update power" onClose={() => setOpen(false)}>
        <ReportForm
          current={reports?.current ?? {}}
          latestPower={latest?.power}
          onSaved={() => {
            setOpen(false);
            reload();
          }}
        />
      </Sheet>
    </>
  );
}

function HeroCard({ latest, previous, series }: { latest: PowerPoint; previous?: PowerPoint | undefined; series: PowerPoint[] }) {
  const delta = change(latest.power, previous?.power);
  return (
    <section className="card hero" aria-label="Current power">
      <span className="hero-label">Current power</span>
      <span className="hero-value">{full(latest.power)}</span>
      <span className="hero-meta">
        {delta && <ChangePill change={delta} since={previous!.effectiveAt} />}
        <span className="muted small">Updated {relativeDay(latest.effectiveAt)}</span>
      </span>
      <LineChart points={series.map((p) => ({ at: p.effectiveAt, value: p.power }))} label="Your power over time" />
    </section>
  );
}

const STAT_LABELS: [string, string][] = [
  ["hero_power_total", "Hero power"],
  ["furnace_level", "Furnace"],
  ["troop_level_infantry", "Infantry troops"],
  ["helios_infantry", "Infantry Helios"],
  ["troop_level_lancer", "Lancer troops"],
  ["helios_lancer", "Lancer Helios"],
  ["troop_level_marksman", "Marksman troops"],
  ["helios_marksman", "Marksman Helios"],
];

function OtherStats({ current }: { current: Reports["current"] }) {
  const stats = STAT_LABELS.filter(([m]) => current[m] !== undefined);
  if (stats.length === 0) return null;
  return (
    <section className="card">
      <dl className="stats">
        {stats.map(([metric, label]) => (
          <div key={metric}>
            <dt>{label}</dt>
            <dd>{full(current[metric]!.value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function History({ series }: { series: PowerPoint[] }) {
  const rows = series.map((p, i) => ({ p, delta: change(p.power, series[i - 1]?.power) })).reverse();
  return (
    <section aria-labelledby="history-title" className="stack">
      <h2 id="history-title" className="section-label">
        History
      </h2>
      <ol className="card list">
        {rows.map(({ p, delta }) => (
          <li key={p.reportId} className="list-row">
            <span className="list-main">
              <strong className="num">{full(p.power)}</strong>
              <span className="muted small">
                {shortDate(p.effectiveAt)} · {SOURCE_LABEL[p.source] ?? p.source}
              </span>
            </span>
            {delta && (
              <span className={`delta delta-${delta.direction}`}>
                {delta.direction === "down" ? "−" : "+"}
                {full(Math.abs(delta.absolute))}
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function ReportForm({
  current,
  latestPower,
  onSaved,
}: {
  current: Reports["current"];
  latestPower: number | undefined;
  onSaved: () => void;
}) {
  const { api, account } = useSession();
  const toast = useToast();
  const initialNumber = (m: string) => {
    const v = current[m]?.value;
    return typeof v === "number" ? formatDigitsInput(String(v)) : "";
  };
  const [power, setPower] = useState(initialNumber("city_power"));
  const [hero, setHero] = useState(initialNumber("hero_power_total"));
  const [furnace, setFurnace] = useState(String(current.furnace_level?.value ?? ""));
  const [furnaceTouched, setFurnaceTouched] = useState(false);
  const furnaceInvalid = furnace.trim() !== "" && !isValidLevel(furnace);
  // A troop type has a level and, on top of it, Helios. All three can hold Helios at once.
  const [troops, setTroops] = useState(() => troopDraftFrom(current));
  const troopLevelInvalid = TROOP_TYPES.some((type) => {
    const level = troops[type].level.trim();
    return level !== "" && !isValidLevel(level);
  });
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const powerValue = parseDigits(power);
  const drop = powerValue !== undefined && latestPower ? (latestPower - powerValue) / latestPower : 0;
  const needsConfirm = drop > DROP_WARNING && !confirmDrop;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!account || powerValue === undefined) return;
    if (furnaceInvalid || troopLevelInvalid) {
      setFurnaceTouched(true);
      return;
    }
    if (needsConfirm) {
      setConfirmDrop(true);
      return;
    }
    const values: { metric: string; value: string | number }[] = [{ metric: "city_power", value: powerValue }];
    const heroValue = parseDigits(hero);
    if (heroValue !== undefined) values.push({ metric: "hero_power_total", value: heroValue });
    if (furnace.trim()) values.push({ metric: "furnace_level", value: furnace.trim() });
    values.push(...troopValues(troops));
    setBusy(true);
    setError(null);
    try {
      await api.addReport(account.playerId, values);
      toast("Report saved");
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="f-power">Power</label>
        <input
          id="f-power"
          inputMode="numeric"
          autoComplete="off"
          value={power}
          onChange={(e) => {
            setPower(formatDigitsInput(e.target.value));
            setConfirmDrop(false);
          }}
          placeholder="45,000,000"
          required
          aria-describedby="f-power-hint"
        />
        <span id="f-power-hint" className="hint">
          From your profile screen in game.
        </span>
      </div>

      <div className="field">
        <label htmlFor="f-hero">Total hero power</label>
        <input
          id="f-hero"
          inputMode="numeric"
          autoComplete="off"
          value={hero}
          onChange={(e) => setHero(formatDigitsInput(e.target.value))}
          placeholder="Optional"
        />
      </div>

      <div className="field">
        <label htmlFor="f-furnace">Furnace level</label>
        <input
          id="f-furnace"
          autoComplete="off"
          autoCapitalize="characters"
          value={furnace}
          onChange={(e) => setFurnace(e.target.value.toUpperCase())}
          onBlur={() => setFurnaceTouched(true)}
          placeholder="e.g. 30 or FC5-2"
          aria-invalid={furnaceInvalid && furnaceTouched}
          aria-describedby={furnaceInvalid && furnaceTouched ? "f-furnace-error" : undefined}
        />
        {furnaceInvalid && furnaceTouched && (
          <span id="f-furnace-error" className="field-error" role="alert">
            {LEVEL_HINT}
          </span>
        )}
      </div>

      <fieldset className="field">
        <legend>Troops</legend>
        <span className="hint">Each type has its own level, up to your furnace. Tick Helios where you have it.</span>
        {TROOP_TYPES.map((type) => {
          const invalid = troops[type].level.trim() !== "" && !isValidLevel(troops[type].level);
          return (
            <div key={type} className="troop-row">
              <span className="troop-name">{TROOP_LABELS[type]}</span>
              <input
                aria-label={`${TROOP_LABELS[type]} troop level`}
                aria-invalid={invalid}
                value={troops[type].level}
                placeholder="FC9"
                inputMode="text"
                onChange={(e) => setTroops((cur) => ({ ...cur, [type]: { ...cur[type], level: e.target.value } }))}
              />
              <label className="chip">
                <input
                  type="checkbox"
                  checked={troops[type].helios}
                  onChange={(e) => setTroops((cur) => ({ ...cur, [type]: { ...cur[type], helios: e.target.checked } }))}
                />
                <span>Helios</span>
              </label>
            </div>
          );
        })}
        {troopLevelInvalid && furnaceTouched && (
          <span className="field-error" role="alert">
            {LEVEL_HINT}
          </span>
        )}
      </fieldset>

      {confirmDrop && drop > DROP_WARNING && (
        <p className="banner banner-warn" role="alert">
          That's {(drop * 100).toFixed(0)}% lower than your last report. Tap save again if it's right.
        </p>
      )}
      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-primary btn-block" disabled={busy || powerValue === undefined || furnaceInvalid}>
        {busy ? "Saving…" : confirmDrop && drop > DROP_WARNING ? "Save anyway" : "Save report"}
      </button>
    </form>
  );
}
