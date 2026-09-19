import { useMemo, useState } from "react";
import { createRequest } from "../api";
import { useToast } from "../components/Toast";
import { freshToken, useSession } from "../session";

/** Local-only tools for loading demo data. The tab and the API routes exist only in local development. */
export function Dev() {
  const { user, account, dataChanged } = useSession();
  const api = useMemo(() => {
    const request = createRequest(freshToken);
    return {
      dev: {
        addMembers: (count: number) => request<{ created: number }>("POST", "/dev/members", { count }),
        backfill: (playerId: string, months: number) => request<{ months: number }>("POST", "/dev/history", { playerId, months }),
        reportRound: () => request<{ members: number; reported: number }>("POST", "/dev/report-round", {}),
        reset: () => request<{ reset: boolean }>("POST", "/dev/reset", {}),
      },
    };
  }, [user]);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState(10);
  const [months, setMonths] = useState(12);

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setError(null);
    try {
      toast(await fn());
      dataChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const actions = [
    {
      key: "members",
      title: "Add members",
      text: "Random POP members, each with 2 to 7 months of history.",
      control: (
        <select aria-label="How many members" value={members} onChange={(e) => setMembers(Number(e.target.value))}>
          {[1, 5, 10, 25].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      ),
      label: "Add",
      fn: async () => `Added ${(await api.dev.addMembers(members)).created} members`,
    },
    {
      key: "history",
      title: "Backfill history",
      text: account ? `Older monthly reports for ${account.name}, before the earliest one.` : "Pick a game account first.",
      control: (
        <select aria-label="How many months" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
          {[3, 6, 12, 24].map((n) => (
            <option key={n} value={n}>
              {n} months
            </option>
          ))}
        </select>
      ),
      label: "Backfill",
      disabled: !account,
      fn: async () => {
        const r = await api.dev.backfill(account!.playerId, months);
        return `Added up to ${r.months} months for ${account!.name}`;
      },
    },
    {
      key: "round",
      title: "Report round",
      text: "About 80% of active members file a fresh report today, with realistic growth.",
      label: "Run",
      fn: async () => {
        const r = await api.dev.reportRound();
        return `${r.reported} of ${r.members} members reported`;
      },
    },
    {
      key: "reset",
      title: "Reset demo data",
      text: "Wipes the local database and reloads the standard demo set.",
      label: "Reset",
      danger: true,
      fn: async () => {
        await api.dev.reset();
        return "Demo data reset";
      },
    },
  ];

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Dev tools</h1>
        <span className="badge badge-warn">local only</span>
      </div>
      <p className="muted">Load demo data to see how screens behave with more members and longer history.</p>

      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}

      <ul className="dev-list">
        {actions.map((a) => (
          <li key={a.key} className="card dev-item">
            <div className="dev-text">
              <strong>{a.title}</strong>
              <span className="muted small">{a.text}</span>
            </div>
            <div className="dev-controls">
              {a.control}
              <button
                type="button"
                className={a.danger ? "btn btn-danger" : "btn btn-quiet"}
                disabled={busy !== null || a.disabled}
                onClick={() => void run(a.key, a.fn)}
              >
                {busy === a.key ? "Working…" : a.label}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <p className="muted small">
        Discord messages sent locally: <a href="http://localhost:8082/messages">localhost:8082/messages</a>
      </p>
    </>
  );
}
