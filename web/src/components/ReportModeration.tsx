import { useState, type FormEvent } from "react";
import { ApiError, type Report } from "../api";
import { useSession } from "../session";
import { Sheet } from "./Sheet";
import { useToast } from "./Toast";

export function ReportModeration({
  playerId,
  report,
  onChanged,
}: {
  playerId: string;
  report: Report;
  onChanged: () => void;
}) {
  const { api } = useSession();
  const toast = useToast();
  const restoring = Boolean(report.ignoredAt);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const cleanReason = reason.trim();
    if (cleanReason.length < 3) return;
    setBusy(true);
    setError(null);
    try {
      await api.setReportIgnored(playerId, report.reportId, !restoring, cleanReason);
      toast(restoring ? "Report restored" : "Report ignored");
      setOpen(false);
      setReason("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update the report. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className={`text-btn report-action ${restoring ? "" : "report-action-ignore"}`} onClick={() => setOpen(true)}>
        {restoring ? "Restore" : "Ignore"}
      </button>
      <Sheet open={open} title={restoring ? "Restore report" : "Ignore report"} onClose={() => !busy && setOpen(false)}>
        <form className="form" onSubmit={submit}>
          <p className="muted">
            {restoring
              ? "This report will be included in current values, charts and calculations again."
              : "The report remains in the audit history, but will no longer affect current values, charts, rankings or rewards."}
          </p>
          <div className="field">
            <label htmlFor={`report-reason-${report.reportId}`}>{restoring ? "Why are you restoring it?" : "Why is this report wrong?"}</label>
            <textarea
              id={`report-reason-${report.reportId}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={3}
              maxLength={300}
              rows={3}
              placeholder={restoring ? "For example: the report was correct after all" : "For example: typo in city power"}
              required
              autoFocus
            />
          </div>
          {error && <p className="banner banner-error" role="alert">{error}</p>}
          <button type="submit" className={`btn btn-block ${restoring ? "btn-primary" : "btn-danger"}`} disabled={busy || reason.trim().length < 3}>
            {busy ? "Saving…" : restoring ? "Restore report" : "Ignore report"}
          </button>
        </form>
      </Sheet>
    </>
  );
}
