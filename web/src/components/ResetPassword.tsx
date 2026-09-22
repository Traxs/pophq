import { useState, type FormEvent } from "react";
import { ApiError, type AccessAuditRecord } from "../api";
import { useSession } from "../session";
import { useToast } from "./Toast";

export function ResetPasswordForm({
  playerId,
  memberName,
  onCompleted,
  onClose,
}: {
  playerId: string;
  memberName: string;
  onCompleted: (audit: AccessAuditRecord) => void;
  onClose: () => void;
}) {
  const { api } = useSession();
  const toast = useToast();
  const [justification, setJustification] = useState("");
  const [password, setPassword] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const ready = justification.trim().length >= 5 && justification.trim().length <= 200;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.resetPassword(playerId, justification.trim());
      setPassword(result.credentials.password);
      onCompleted(result.audit);
      toast(`${memberName}'s password was reset and audited`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reset this password. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (password) return <section className="invite-credentials" aria-labelledby="reset-ready-title">
    <div className="success-mark" aria-hidden="true">✓</div>
    <h2 id="reset-ready-title">Temporary password created</h2>
    <p className="muted">Share it privately with {memberName}. It is shown only now. Their login name stays the same.</p>
    <div className="credential-row">
      <span><small>Temporary password</small><code>{password}</code></span>
      <button type="button" className="btn btn-quiet btn-small" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
    </div>
    <p className="banner banner-warn small">They must sign in within 7 days and choose a new private password.</p>
    <button type="button" className="btn btn-primary btn-block" onClick={onClose}>Done</button>
  </section>;

  return <form className="form" onSubmit={submit}>
    <p className="banner banner-warn">This immediately invalidates {memberName}'s current password. The officer, reason, time, and outcome are permanently audited.</p>
    <div className="field">
      <label htmlFor="reset-justification">Why is access being reset?</label>
      <textarea
        id="reset-justification"
        rows={3}
        maxLength={200}
        value={justification}
        onChange={(event) => setJustification(event.target.value)}
        placeholder="Member verified their identity and forgot the password"
      />
      <span className="hint">5–200 characters · never include a password</span>
    </div>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    <button type="submit" className="btn btn-danger btn-block" disabled={busy || !ready}>
      {busy ? "Resetting…" : "Reset password"}
    </button>
  </form>;
}
