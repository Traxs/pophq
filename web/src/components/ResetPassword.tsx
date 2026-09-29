import { useState, type FormEvent } from "react";
import { ApiError, type AccessAuditRecord, type IssuedOnboardingInvitation } from "../api";
import { displayLoginName } from "../loginNames";
import { useSession } from "../session";
import { useToast } from "./Toast";

export function ResetPasswordForm({
  playerId,
  memberName,
  onCompleted,
  onInvitationCreated,
  onClose,
}: {
  playerId: string;
  memberName: string;
  onCompleted: (audit: AccessAuditRecord) => void;
  onInvitationCreated: () => void;
  onClose: () => void;
}) {
  const { api } = useSession();
  const toast = useToast();
  const [justification, setJustification] = useState("");
  const [mode, setMode] = useState<"link" | "direct">("link");
  const [invitation, setInvitation] = useState<IssuedOnboardingInvitation>();
  const [credentials, setCredentials] = useState<{ username?: string; password: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedRecovery, setCopiedRecovery] = useState<"message" | "link" | null>(null);
  const ready = justification.trim().length >= 5 && justification.trim().length <= 200;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "link") {
        const issued = await api.issuePasswordRecoveryInvitation(playerId, justification.trim());
        setInvitation(issued);
        onInvitationCreated();
        toast(`Secure recovery invitation created for ${memberName}`);
        return;
      }
      const result = await api.resetPassword(playerId, justification.trim());
      setCredentials(result.credentials);
      onCompleted(result.audit);
      toast(`${memberName}'s password was reset and audited`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reset this password. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (invitation) {
    const url = `${window.location.origin}/join#${invitation.token}`;
    const message = `This is your POP HQ recovery link for ${memberName}.\n\nOpen this private link within 24 hours:\n${url}\n\nIt works once. Tap Continue to copy the temporary password, paste it into Cognito, then choose your own password.`;
    const copyRecovery = async (kind: "message" | "link", value: string, success: string) => {
      try {
        await navigator.clipboard.writeText(value);
        setCopiedRecovery(kind);
        setError(null);
        toast(success);
      } catch {
        setCopiedRecovery(null);
        setError("Your browser blocked copying. Select and copy the recovery link manually.");
      }
    };
    return <section className="invite-credentials" aria-labelledby="recovery-ready-title">
      <div className="success-mark" aria-hidden="true">✓</div>
      <h2 id="recovery-ready-title">Recovery link ready</h2>
      <p className="muted">Send this privately to {memberName}. Opening it does not require an email address.</p>
      <div className="invite-link"><code>{url}</code></div>
      <ul className="small muted">
        <li>Expires {new Date(invitation.expiresAt).toLocaleString()}</li>
        <li>Works once and is bound to Player ID {invitation.playerId}</li>
        <li>The password changes only when {memberName} uses the link</li>
      </ul>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <button type="button" className="btn btn-primary btn-block" onClick={() => void copyRecovery("message", message, `Recovery message copied for ${memberName}`)}>{copiedRecovery === "message" ? "Recovery message copied" : "Copy recovery message"}</button>
      <button type="button" className="btn btn-quiet btn-block" onClick={() => void copyRecovery("link", url, "Recovery link copied")}>{copiedRecovery === "link" ? "Recovery link copied" : "Copy link only"}</button>
      <button type="button" className="btn btn-quiet btn-block" onClick={onClose}>Done</button>
    </section>;
  }

  const copy = async () => {
    if (!credentials) return;
    try {
      await navigator.clipboard.writeText(credentials.password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (credentials) return <section className="invite-credentials" aria-labelledby="reset-ready-title">
    <div className="success-mark" aria-hidden="true">✓</div>
    <h2 id="reset-ready-title">Temporary password created</h2>
    <p className="muted">Share it privately with {memberName}. It is shown only now.</p>
    {credentials.username && <div className="credential-row">
      <span><small>Login name</small><code>{displayLoginName(credentials.username)}</code></span>
    </div>}
    <div className="credential-row">
      <span><small>Temporary password</small><code>{credentials.password}</code></span>
      <button type="button" className="btn btn-quiet btn-small" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
    </div>
    <p className="banner banner-warn small">They must sign in within 7 days and choose a new private password.</p>
    <button type="button" className="btn btn-primary btn-block" onClick={onClose}>Done</button>
  </section>;

  return <form className="form" onSubmit={submit}>
    <div className="segmented" role="radiogroup" aria-label="Recovery method">
      <button type="button" className={mode === "link" ? "selected" : ""} aria-pressed={mode === "link"} onClick={() => setMode("link")}>Recovery link</button>
      <button type="button" className={mode === "direct" ? "selected" : ""} aria-pressed={mode === "direct"} onClick={() => setMode("direct")}>Officer reset</button>
    </div>
    <p className={`banner ${mode === "direct" ? "banner-warn" : "banner-info"}`}>
      {mode === "link"
        ? `Recommended: ${memberName} opens a private one-time link and receives their login and temporary password directly.`
        : `This immediately invalidates ${memberName}'s current password. You must share the temporary password privately.`}
    </p>
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
    <button type="submit" className={`btn ${mode === "link" ? "btn-primary" : "btn-danger"} btn-block`} disabled={busy || !ready}>
      {busy ? (mode === "link" ? "Creating link…" : "Resetting…") : mode === "link" ? "Create 24-hour recovery link" : "Reset password now"}
    </button>
  </form>;
}
