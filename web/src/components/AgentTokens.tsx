import { useEffect, useState } from "react";
import { ApiError, type AgentScope, type AgentTokenInfo } from "../api";
import { shortDate } from "../format";
import { useSession } from "../session";
import { useToast } from "./Toast";

export function AgentTokens() {
  const { api } = useSession();
  const toast = useToast();
  const [items, setItems] = useState<AgentTokenInfo[]>([]);
  const [name, setName] = useState("Results bot");
  const [days, setDays] = useState(30);
  const [write, setWrite] = useState(true);
  const [eventsWrite, setEventsWrite] = useState(true);
  const [historyWrite, setHistoryWrite] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.agentTokens().then((result) => setItems(result.items)).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, [api]);

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      const scopes: AgentScope[] = [
        "all:read",
        ...(write ? ["results:write" as const] : []),
        ...(eventsWrite ? ["events:write" as const] : []),
        ...(historyWrite ? ["history:write" as const] : []),
      ];
      const issued = await api.issueAgentToken({ name, scopes, expiresInDays: days });
      setSecret(issued.token);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't issue the token.");
    } finally { setBusy(false); }
  };

  const scopeLabel = (scope: AgentScope) =>
    scope === "results:write" ? "Update results" : scope === "events:write" ? "Manage events" : scope === "history:write" ? "Import history" : "Read data";

  return (
    <section className="card bot-token-panel" aria-labelledby="agent-token-title">
      <h2 id="agent-token-title" className="section-label">Bot tokens</h2>
      <p className="muted small">A bot can read everything you can currently read. Optional writes stop working if you are no longer an officer.</p>
      <div className="bot-token-form">
        <div className="form-grid">
          <label className="field"><span>Name</span><input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>Expires</span><select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label>
        </div>
        <label className="checkbox-row"><input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} /><span>Allow result updates <span className="muted">(preview remains the default)</span></span></label>
        <label className="checkbox-row"><input type="checkbox" checked={eventsWrite} onChange={(e) => setEventsWrite(e.target.checked)} /><span>Allow event creation and editing <span className="muted">(including historical events; preview remains the default)</span></span></label>
        <label className="checkbox-row"><input type="checkbox" checked={historyWrite} onChange={(e) => setHistoryWrite(e.target.checked)} /><span>Allow historical data imports <span className="muted">(strength, signups, attendance, lineups and tactics)</span></span></label>
        <div className="bot-token-actions">
          <button type="button" className="btn btn-primary btn-small" disabled={busy || !name.trim()} onClick={() => void issue()}>{busy ? "Issuing…" : "Issue token"}</button>
        </div>
      </div>
      {secret && <div className="banner banner-warn"><div><strong>Copy this now — it will not be shown again.</strong><textarea className="token-secret" rows={3} readOnly value={secret} onFocus={(e) => e.currentTarget.select()} /></div></div>}
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      {items.length > 0 && <ul className="movers bot-token-list">{items.map((item) => <li key={item.tokenId} className="mover"><span><strong>{item.name}</strong><span className="muted small bot-token-meta">{item.scopes.map(scopeLabel).join(" · ")} · expires {shortDate(item.expiresAt)}{item.revokedAt ? " · revoked" : item.lastUsedAt ? ` · used ${shortDate(item.lastUsedAt)}` : " · unused"}</span></span>{!item.revokedAt && <button type="button" className="text-btn" onClick={() => { void api.revokeAgentToken(item.tokenId).then(() => { toast("Bot token revoked"); return load(); }); }}>Revoke</button>}</li>)}</ul>}
    </section>
  );
}
