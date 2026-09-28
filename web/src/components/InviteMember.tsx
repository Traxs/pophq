import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, type InviteResult, type IssuedOnboardingInvitation, type RosterRow } from "../api";
import { inviteSuggestions } from "../inviteCandidates";
import { summarise } from "../invites";
import { displayLoginName } from "../loginNames";
import { isValidEmail, isValidGameName, isValidPlayerId } from "../rules";
import { useSession } from "../session";
import { useToast } from "./Toast";

export function InviteMemberForm({ candidates, initialAccount, onChanged, onClose }: {
  candidates: readonly RosterRow[];
  initialAccount?: RosterRow | undefined;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { api } = useSession();
  const toast = useToast();
  const [setupMode, setSetupMode] = useState<"link" | "officer">("link");
  const [directMethod, setDirectMethod] = useState<"email" | "password">("email");
  const [lookup, setLookup] = useState("");
  const [lookupOpen, setLookupOpen] = useState(false);
  const [playerId, setPlayerId] = useState(initialAccount?.playerId ?? "");
  const [name, setName] = useState(initialAccount?.name ?? "");
  const [rank, setRank] = useState(initialAccount?.rank ?? "");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [invitation, setInvitation] = useState<IssuedOnboardingInvitation>();
  const [credentials, setCredentials] = useState<InviteResult["credentials"]>();
  const [copied, setCopied] = useState(false);
  const [copiedCredential, setCopiedCredential] = useState<string>();
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!initialAccount) return;
    setLookup(initialAccount.name);
    setPlayerId(initialAccount.playerId);
    setName(initialAccount.name);
    setRank(initialAccount.rank ?? "");
  }, [initialAccount]);

  const suggestions = useMemo(() => lookupOpen ? inviteSuggestions(candidates, lookup) : [], [candidates, lookup, lookupOpen]);
  const select = (candidate: RosterRow) => {
    setLookup(candidate.name);
    setPlayerId(candidate.playerId);
    setName(candidate.name);
    setRank(candidate.rank ?? "");
    setLookupOpen(false);
    setTouched({});
  };
  const emailBad = setupMode === "officer" && directMethod === "email" && email.trim() !== "" && !isValidEmail(email);
  const playerIdBad = playerId.trim() !== "" && !isValidPlayerId(playerId);
  const nameBad = name.trim() !== "" && !isValidGameName(name);
  const ready = isValidPlayerId(playerId)
    && isValidGameName(name)
    && (setupMode === "link" || directMethod === "password" || isValidEmail(email));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) {
      setTouched({ email: true, playerId: true, name: true });
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      if (setupMode === "link") {
        const result = await api.issueOnboardingInvitation({ playerId: playerId.trim(), name: name.trim(), ...(rank ? { rank } : {}) });
        setInvitation(result);
        onChanged();
        toast(`Secure invitation created for ${result.playerName}`);
      } else {
        const result = await api.invite({
          loginMethod: directMethod,
          ...(directMethod === "email" ? { email: email.trim() } : {}),
          playerId: playerId.trim(),
          name: name.trim(),
          ...(rank ? { rank } : {}),
        });
        toast(summarise(result));
        onChanged();
        if (result.credentials) setCredentials(result.credentials);
        else onClose();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create access. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const copyCredential = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedCredential(label);
    } catch {
      setCopiedCredential(undefined);
      setError("Your browser blocked copying. Select and copy the credentials manually.");
    }
  };

  if (credentials) {
    const friendlyLoginName = displayLoginName(credentials.username);
    const both = `POP HQ login\nLogin name: ${friendlyLoginName}\nTemporary password: ${credentials.password}\nSign in at ${window.location.origin}`;
    return <section className="invite-credentials" aria-labelledby="credentials-title">
      <div className="success-mark" aria-hidden="true">✓</div>
      <h2 id="credentials-title">Temporary login created</h2>
      <p className="muted">Share this privately with the member. It is shown only now. They must sign in within 7 days and choose a private password.</p>
      <Credential label="Login name" value={friendlyLoginName} onCopy={() => void copyCredential("Login name", friendlyLoginName)} />
      <Credential label="Temporary password" value={credentials.password} onCopy={() => void copyCredential("Password", credentials.password)} />
      <button type="button" className="btn btn-quiet btn-block" onClick={() => void copyCredential("Both", both)}>
        {copiedCredential === "Both" ? "Copied login and password" : "Copy both"}
      </button>
      {copiedCredential && copiedCredential !== "Both" && <p className="muted small center">{copiedCredential} copied</p>}
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <p className="banner banner-warn small">There is no email recovery. If they lose their password, an R4 must verify them before their access can be reset.</p>
      <button type="button" className="btn btn-primary btn-block" onClick={onClose}>Done</button>
    </section>;
  }

  if (invitation) {
    const url = `${window.location.origin}/join#${invitation.token}`;
    const message = `You’ve been invited to POP HQ as ${invitation.playerName}.\n\nOpen this private link within 24 hours:\n${url}\n\nThe link works once. You can choose email code or a login and password.`;
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(message);
        setCopied(true);
      } catch {
        setError("Your browser blocked copying. Select and copy the link manually.");
      }
    };
    return <section className="invite-credentials" aria-labelledby="invite-ready-title">
      <div className="success-mark" aria-hidden="true">✓</div>
      <h2 id="invite-ready-title">Invitation ready</h2>
      <p>Send this privately to <strong>{invitation.playerName}</strong>. It is linked to Player ID {invitation.playerId}.</p>
      <div className="invite-link"><code>{url}</code></div>
      <ul className="security-checks small">
        <li>Expires {new Date(invitation.expiresAt).toLocaleString()}</li>
        <li>Works once—even a failed redemption closes it</li>
        <li>The player chooses email code or Cognito-managed password</li>
      </ul>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <button type="button" className="btn btn-primary btn-block" onClick={() => void copy()}>{copied ? "Invitation copied" : "Copy invitation"}</button>
      <button type="button" className="btn btn-quiet btn-block" onClick={onClose}>Done</button>
    </section>;
  }

  return <form className="form" onSubmit={submit} noValidate>
    <fieldset className="field">
      <legend>How do you want to give access?</legend>
      <div className="invite-paths" role="radiogroup" aria-label="Access setup">
        <button type="button" className={setupMode === "link" ? "selected" : ""} role="radio" aria-checked={setupMode === "link"} onClick={() => setSetupMode("link")}>
          <span className="invite-path-heading"><strong>Invitation link</strong><span className="recommended-pill">Recommended</span></span>
          <span>Send one private link. The player chooses email code or password.</span>
          <small>One use · expires in 24 hours</small>
        </button>
        <button type="button" className={setupMode === "officer" ? "selected" : ""} role="radio" aria-checked={setupMode === "officer"} onClick={() => setSetupMode("officer")}>
          <span className="invite-path-heading"><strong>Set up access for them</strong></span>
          <span>Enter their email or receive a temporary login to share.</span>
          <small>Use when they cannot open an invitation link</small>
        </button>
      </div>
    </fieldset>
    {candidates.some((candidate) => !candidate.hasLogin) && <div className="field member-lookup">
      <label htmlFor="i-lookup">Find an existing member</label>
      <input id="i-lookup" role="combobox" aria-autocomplete="list" aria-expanded={suggestions.length > 0} autoComplete="off" value={lookup}
        onFocus={() => setLookupOpen(true)} onChange={(event) => { setLookup(event.target.value); setLookupOpen(true); }} placeholder="Start typing a name or Player ID" />
      {suggestions.length > 0 && <ul className="member-suggestions" role="listbox">{suggestions.map((candidate) => <li key={candidate.playerId} role="option" aria-selected={candidate.playerId === playerId}>
        <button type="button" onClick={() => select(candidate)}><strong>{candidate.name}</strong><span>{candidate.playerId}{candidate.rank ? ` · ${candidate.rank}` : ""}</span></button>
      </li>)}</ul>}
      <span className="hint">Selecting someone fills their name, Player ID and rank.</span>
    </div>}
    {setupMode === "officer" && <fieldset className="field">
      <legend>Sign-in method</legend>
      <div className="segmented invite-method" role="radiogroup" aria-label="Sign-in method">
        <button type="button" role="radio" aria-checked={directMethod === "email"} onClick={() => setDirectMethod("email")}>Email code</button>
        <button type="button" role="radio" aria-checked={directMethod === "password"} onClick={() => setDirectMethod("password")}>Temporary password</button>
      </div>
      <span className="hint">{directMethod === "email" ? "They receive a one-time code whenever they sign in." : "No personal email is stored. You share the generated login once."}</span>
    </fieldset>}
    {setupMode === "officer" && directMethod === "email" && <div className="field">
      <label htmlFor="i-email">Email</label>
      <input id="i-email" type="email" inputMode="email" autoComplete="off" autoCapitalize="none" value={email} onChange={(event) => setEmail(event.target.value)} onBlur={() => setTouched((current) => ({ ...current, email: true }))} placeholder="name@example.com" aria-invalid={emailBad && touched.email} />
      {emailBad && touched.email && <span className="field-error" role="alert">Enter a valid email address.</span>}
    </div>}
    {setupMode === "officer" && <p className="banner banner-warn small">Use this path only when the member cannot use an invitation link. You are handling their initial access.</p>}
    <div className="field"><label htmlFor="i-player">Player ID</label><input id="i-player" inputMode="numeric" autoComplete="off" value={playerId} onChange={(event) => setPlayerId(event.target.value.replace(/[^0-9]/g, ""))} onBlur={() => setTouched((current) => ({ ...current, playerId: true }))} placeholder="410691488" aria-invalid={playerIdBad && touched.playerId} />{playerIdBad && touched.playerId && <span className="field-error" role="alert">Player IDs are 5 to 15 digits.</span>}</div>
    <div className="field"><label htmlFor="i-name">Game name</label><input id="i-name" autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} onBlur={() => setTouched((current) => ({ ...current, name: true }))} placeholder="Frostbite" aria-invalid={nameBad && touched.name} />{nameBad && touched.name && <span className="field-error" role="alert">Use 2 to 30 characters.</span>}</div>
    <div className="field"><label htmlFor="i-rank">Rank</label><select id="i-rank" value={rank} onChange={(event) => setRank(event.target.value)}><option value="">Not set</option>{["R1", "R2", "R3", "R4", "R5"].map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    <button type="submit" className="btn btn-primary btn-block" disabled={busy || !ready}>{busy ? "Creating access…" : setupMode === "link" ? "Create 24-hour invitation" : directMethod === "email" ? "Create email-code access" : "Create temporary login"}</button>
  </form>;
}

function Credential({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return <div className="credential-row">
    <span><small>{label}</small><code>{value}</code></span>
    <button type="button" className="btn btn-quiet btn-small" onClick={onCopy}>Copy</button>
  </div>;
}
