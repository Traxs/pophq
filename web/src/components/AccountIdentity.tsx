import { useMemo, useState, type FormEvent } from "react";
import type { AccountIdentity, IdentityAuditRecord, RosterRow } from "../api";
import { shortDate } from "../format";
import { useSession } from "../session";
import { ErrorBanner } from "./Chrome";
import { Sheet } from "./Sheet";

type Action =
  | { type: "link" }
  | { type: "main"; playerId: string; name: string }
  | { type: "unlink"; playerId: string; name: string }
  | { type: "alias"; playerId: string; name: string };

const AUDIT_LABELS: Record<IdentityAuditRecord["action"], string> = {
  link_secondary: "Linked secondary account",
  unlink_secondary: "Unlinked secondary account",
  set_main: "Changed main account",
  alias_add: "Added previous name",
};

export function AccountIdentityPanel({
  anchorPlayerId,
  identity,
  roster,
  onChanged,
}: {
  anchorPlayerId: string;
  identity: AccountIdentity;
  roster: RosterRow[];
  onChanged: (identity: AccountIdentity) => void;
}) {
  const { api, dataChanged } = useSession();
  const [action, setAction] = useState<Action | null>(null);
  const [secondaryPlayerId, setSecondaryPlayerId] = useState("");
  const [lookup, setLookup] = useState("");
  const [alias, setAlias] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const linked = useMemo(() => new Set(identity.accounts.map((account) => account.playerId)), [identity.accounts]);
  const candidates = roster.filter((account) => !linked.has(account.playerId) && !account.hasLogin && account.status !== "transferred_out");
  const selectedSecondary = candidates.find((candidate) => candidate.playerId === secondaryPlayerId);

  const open = (next: Action) => {
    setAction(next);
    setSecondaryPlayerId("");
    setLookup("");
    setAlias("");
    setReason("");
    setError(null);
  };

  const close = () => !saving && setAction(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!action) return;
    setSaving(true);
    setError(null);
    try {
      const updated = action.type === "link"
        ? await api.linkSecondaryAccount(anchorPlayerId, secondaryPlayerId, reason)
        : action.type === "main"
          ? await api.setPrimaryAccount(anchorPlayerId, action.playerId, reason)
          : action.type === "unlink"
            ? await api.unlinkSecondaryAccount(anchorPlayerId, action.playerId, reason)
            : await api.addAccountAlias(action.playerId, alias, reason);
      onChanged(updated);
      dataChanged();
      setAction(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the account relationship.");
    } finally {
      setSaving(false);
    }
  };

  const title = action?.type === "link" ? "Link secondary account"
    : action?.type === "main" ? `Make ${action.name} the main account`
      : action?.type === "unlink" ? `Unlink ${action.name}`
        : action?.type === "alias" ? `Add a previous name for ${action.name}` : "Accounts & names";
  const submitLabel = action?.type === "link" ? "Link accounts"
    : action?.type === "main" ? "Make main account"
      : action?.type === "unlink" ? "Unlink account"
        : action?.type === "alias" ? "Add name" : "Save change";

  return <section className="card member-detail-card identity-card">
    <div className="section-head">
      <div>
        <h2>Accounts &amp; names</h2>
        <p className="muted small">One person, with separate Player IDs and histories.</p>
      </div>
      <button type="button" className="btn btn-primary btn-small" disabled={candidates.length === 0 || !identity.accounts.some((a) => a.isPrimary)} onClick={() => open({ type: "link" })}>Link account</button>
    </div>

    <ul className="identity-account-list">
      {identity.accounts.map((account) => <li key={account.playerId}>
        <div className="identity-account-copy">
          <span><strong>{account.name}</strong>{account.isPrimary && <span className="badge identity-main-badge">Main</span>}</span>
          <span className="muted small">Player ID {account.playerId}</span>
          {account.aliases.length > 0 && <span className="small">Previous names: {account.aliases.map((item) => item.name).join(", ")}</span>}
        </div>
        <div className="identity-actions">
          <button type="button" className="text-btn" onClick={() => open({ type: "alias", playerId: account.playerId, name: account.name })}>Add name</button>
          {!account.isPrimary && <button type="button" className="text-btn" onClick={() => open({ type: "main", playerId: account.playerId, name: account.name })}>Make main</button>}
          {!account.isPrimary && <button type="button" className="text-btn danger-text" onClick={() => open({ type: "unlink", playerId: account.playerId, name: account.name })}>Unlink</button>}
        </div>
      </li>)}
    </ul>

    <details className="identity-audit">
      <summary>Relationship history ({identity.audit.length})</summary>
      {identity.audit.length === 0 ? <p className="muted small">No identity changes recorded yet.</p> : <ul className="detail-list">
        {identity.audit.map((entry) => <li key={entry.auditId}>
          <span>
            <strong>{AUDIT_LABELS[entry.action]}</strong>
            <span className="muted small">{shortDate(entry.performedAt)} · {entry.performedByName ?? "R4/R5"}</span>
            <span className="small">{entry.alias ? `“${entry.alias}” · ` : ""}{entry.relatedPlayerId ? `Player ID ${entry.relatedPlayerId} · ` : ""}{entry.justification}</span>
          </span>
        </li>)}
      </ul>}
    </details>

    <Sheet open={action !== null} title={title} onClose={close}>
      <form className="form identity-form" onSubmit={submit}>
        {error && <ErrorBanner message={error} />}
        {action?.type === "link" && <>
          <p className="muted identity-form-intro">Connect another Player ID to this person. Event participation and account history will be combined under the main account.</p>
          <div className="field member-lookup identity-lookup">
            <label htmlFor="identity-account-search">Find the secondary account</label>
            <input id="identity-account-search" role="combobox" aria-autocomplete="list" aria-controls="identity-account-results"
              aria-expanded={Boolean(lookup.trim() && !secondaryPlayerId)} autoComplete="off" value={lookup}
              onChange={(event) => { setLookup(event.target.value); setSecondaryPlayerId(""); }}
              placeholder="Search by name or Player ID" autoFocus />
            {lookup.trim() && !secondaryPlayerId && <ul id="identity-account-results" className="member-suggestions" role="listbox">
              {candidates.filter((candidate) => {
                const query = lookup.trim().toLowerCase();
                return candidate.name.toLowerCase().includes(query) || candidate.playerId.includes(query) || (candidate.aliases ?? []).some((name) => name.toLowerCase().includes(query));
              }).slice(0, 8).map((candidate) => <li key={candidate.playerId} role="option">
                <button type="button" onClick={() => { setLookup(`${candidate.name} · ${candidate.playerId}`); setSecondaryPlayerId(candidate.playerId); }}>
                  <strong>{candidate.name}</strong><span>Player ID {candidate.playerId}{candidate.rank ? ` · ${candidate.rank}` : ""}</span>
                </button>
              </li>)}
            </ul>}
            <span className="field-help">Only accounts without their own sign-in or another main account can be linked.</span>
          </div>
          {selectedSecondary && <div className="identity-selected-account" aria-live="polite">
            <span className="identity-selected-check" aria-hidden="true">✓</span>
            <span><strong>{selectedSecondary.name}</strong><small>Player ID {selectedSecondary.playerId}{selectedSecondary.rank ? ` · ${selectedSecondary.rank}` : ""}</small></span>
            <button type="button" className="text-btn" onClick={() => { setLookup(""); setSecondaryPlayerId(""); }}>Change</button>
          </div>}
        </>}
        {action?.type === "alias" && <div className="field">
          <label htmlFor="identity-alias">Previous or alternate name</label>
          <input id="identity-alias" value={alias} onChange={(event) => setAlias(event.target.value)} minLength={2} maxLength={30} autoFocus required />
        </div>}
        <div className="field identity-reason">
          <label htmlFor="identity-reason">Reason for this change</label>
          <textarea id="identity-reason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={200} placeholder="Explain how this account relationship was confirmed" rows={3} required />
          <span className="field-help">This note is saved permanently in the officer audit history.</span>
        </div>
        <div className="form-actions identity-form-actions">
          <button type="button" className="btn btn-secondary" onClick={close}>Cancel</button>
          <button type="submit" className={`btn ${action?.type === "unlink" ? "btn-danger" : "btn-primary"}`} disabled={saving || (action?.type === "link" && !secondaryPlayerId)}>{saving ? "Saving…" : submitLabel}</button>
        </div>
      </form>
    </Sheet>
  </section>;
}
