import { useState, type FormEvent } from "react";
import type { AccountIdentity } from "../api";
import { useSession } from "../session";
import { ErrorBanner } from "./Chrome";

function today(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function DepartureDateForm({
  playerId,
  memberName,
  currentDate,
  onCompleted,
  onClose,
}: {
  playerId: string;
  memberName: string;
  currentDate: string | null;
  onCompleted: (identity: AccountIdentity) => void;
  onClose: () => void;
}) {
  const { api } = useSession();
  const [effectiveDate, setEffectiveDate] = useState(currentDate?.slice(0, 10) ?? today());
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onCompleted(await api.correctMembershipDate(playerId, effectiveDate, reason));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the departure date.");
    } finally {
      setSaving(false);
    }
  };

  return <form className="form identity-form" onSubmit={submit}>
    {error && <ErrorBanner message={error} />}
    <p className="muted identity-form-intro">
      Events on or after this date will not count toward {memberName}'s attendance until they return.
    </p>
    <div className="field">
      <label htmlFor="departure-effective-date">Date they left POP</label>
      <input id="departure-effective-date" type="date" value={effectiveDate} max={today()} onChange={(event) => setEffectiveDate(event.target.value)} required autoFocus />
      <span className="field-help">The original officer action remains visible in the audit history.</span>
    </div>
    <div className="field identity-reason">
      <label htmlFor="departure-date-reason">Reason for correcting this date</label>
      <textarea id="departure-date-reason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={200} rows={3} required placeholder="How was the correct departure date confirmed?" />
    </div>
    <div className="form-actions identity-form-actions">
      <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn btn-primary" disabled={saving || !effectiveDate || reason.trim().length < 5}>{saving ? "Saving…" : "Update date"}</button>
    </div>
  </form>;
}
