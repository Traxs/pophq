import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, type InviteResult, type RosterRow } from "../api";
import { inviteSuggestions } from "../inviteCandidates";
import { summarise } from "../invites";
import { isValidEmail, isValidGameName, isValidPlayerId } from "../rules";
import { useSession } from "../session";
import { useToast } from "./Toast";

type Method = "email" | "password";

export function InviteMemberForm({
  candidates,
  initialAccount,
  onChanged,
  onClose,
}: {
  candidates: readonly RosterRow[];
  initialAccount?: RosterRow | undefined;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { api } = useSession();
  const toast = useToast();
  const [method, setMethod] = useState<Method>("email");
  const [lookup, setLookup] = useState("");
  const [lookupOpen, setLookupOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [playerId, setPlayerId] = useState(initialAccount?.playerId ?? "");
  const [name, setName] = useState(initialAccount?.name ?? "");
  const [rank, setRank] = useState(initialAccount?.rank ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<InviteResult["credentials"]>();
  const [copied, setCopied] = useState<string | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!initialAccount) return;
    setLookup(initialAccount.name);
    setPlayerId(initialAccount.playerId);
    setName(initialAccount.name);
    setRank(initialAccount.rank ?? "");
  }, [initialAccount]);

  const suggestions = useMemo(
    () => lookupOpen ? inviteSuggestions(candidates, lookup) : [],
    [candidates, lookup, lookupOpen],
  );

  const select = (candidate: RosterRow) => {
    setLookup(candidate.name);
    setPlayerId(candidate.playerId);
    setName(candidate.name);
    setRank(candidate.rank ?? "");
    setLookupOpen(false);
    setTouched({});
  };

  const emailBad = method === "email" && email.trim() !== "" && !isValidEmail(email);
  const playerIdBad = playerId.trim() !== "" && !isValidPlayerId(playerId);
  const nameBad = name.trim() !== "" && !isValidGameName(name);
  const ready = isValidPlayerId(playerId)
    && isValidGameName(name)
    && (method === "password" || isValidEmail(email));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) {
      setTouched({ email: true, playerId: true, name: true });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.invite({
        loginMethod: method,
        ...(method === "email" ? { email: email.trim() } : {}),
        playerId: playerId.trim(),
        name: name.trim(),
        ...(rank ? { rank } : {}),
      });
      toast(summarise(result));
      onChanged();
      if (result.credentials) setCredentials(result.credentials);
      else onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't invite. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied(null);
    }
  };

  if (credentials) {
    const both = `POP HQ login\nLogin name: ${credentials.username}\nTemporary password: ${credentials.password}`;
    return (
      <section className="invite-credentials" aria-labelledby="credentials-title">
        <div className="success-mark" aria-hidden="true">✓</div>
        <h2 id="credentials-title">Temporary login created</h2>
        <p className="muted">Share this privately with the member. It is shown only now. They must sign in within 7 days and choose a private password.</p>
        <Credential label="Login name" value={credentials.username} onCopy={() => void copy("Login name", credentials.username)} />
        <Credential label="Temporary password" value={credentials.password} onCopy={() => void copy("Password", credentials.password)} />
        <button type="button" className="btn btn-quiet btn-block" onClick={() => void copy("Both", both)}>
          {copied === "Both" ? "Copied login and password" : "Copy both"}
        </button>
        {copied && copied !== "Both" && <p className="muted small center">{copied} copied</p>}
        <p className="banner banner-warn small">There is no email recovery. If they lose their password, an R4 must verify them before their access can be reset.</p>
        <button type="button" className="btn btn-primary btn-block" onClick={onClose}>Done</button>
      </section>
    );
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      {candidates.some((candidate) => !candidate.hasLogin) && (
        <div className="field member-lookup">
          <label htmlFor="i-lookup">Find an existing member</label>
          <input
            id="i-lookup"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestions.length > 0}
            autoComplete="off"
            value={lookup}
            onFocus={() => setLookupOpen(true)}
            onChange={(event) => {
              setLookup(event.target.value);
              setLookupOpen(true);
            }}
            placeholder="Start typing a name or Player ID"
          />
          {suggestions.length > 0 && (
            <ul className="member-suggestions" role="listbox">
              {suggestions.map((candidate) => (
                <li key={candidate.playerId} role="option" aria-selected={candidate.playerId === playerId}>
                  <button type="button" onClick={() => select(candidate)}>
                    <strong>{candidate.name}</strong>
                    <span>{candidate.playerId}{candidate.rank ? ` · ${candidate.rank}` : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <span className="hint">Selecting someone fills their name, Player ID and rank.</span>
        </div>
      )}

      <fieldset className="field">
        <legend>How should they sign in?</legend>
        <div className="segmented invite-method" role="radiogroup" aria-label="Sign-in method">
          <button type="button" role="radio" aria-checked={method === "email"} onClick={() => setMethod("email")}>Email code</button>
          <button type="button" role="radio" aria-checked={method === "password"} onClick={() => setMethod("password")}>Create password</button>
        </div>
        <span className="hint">
          {method === "email"
            ? "They receive a one-time code whenever they sign in."
            : "No personal email is stored. You give them a temporary login and password once."}
        </span>
      </fieldset>

      {method === "email" && (
        <div className="field">
          <label htmlFor="i-email">Email</label>
          <input id="i-email" type="email" inputMode="email" autoComplete="off" autoCapitalize="none"
            value={email} onChange={(event) => setEmail(event.target.value)}
            onBlur={() => setTouched((current) => ({ ...current, email: true }))}
            placeholder="name@example.com" aria-invalid={emailBad && touched.email} />
          {emailBad && touched.email && <span className="field-error" role="alert">Enter a valid email address.</span>}
        </div>
      )}

      <div className="field">
        <label htmlFor="i-player">Player ID</label>
        <input id="i-player" inputMode="numeric" autoComplete="off" value={playerId}
          onChange={(event) => setPlayerId(event.target.value.replace(/[^0-9]/g, ""))}
          onBlur={() => setTouched((current) => ({ ...current, playerId: true }))}
          placeholder="410691488" aria-invalid={playerIdBad && touched.playerId} />
        {playerIdBad && touched.playerId && <span className="field-error" role="alert">Player IDs are 5 to 15 digits.</span>}
      </div>

      <div className="field">
        <label htmlFor="i-name">Game name</label>
        <input id="i-name" autoComplete="off" value={name} onChange={(event) => setName(event.target.value)}
          onBlur={() => setTouched((current) => ({ ...current, name: true }))}
          placeholder="Frostbite" aria-invalid={nameBad && touched.name} />
        {nameBad && touched.name && <span className="field-error" role="alert">Use 2 to 30 characters.</span>}
      </div>

      <div className="field">
        <label htmlFor="i-rank">Rank</label>
        <select id="i-rank" value={rank} onChange={(event) => setRank(event.target.value)}>
          <option value="">Not set</option>
          {["R1", "R2", "R3", "R4", "R5"].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>

      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !ready}>
        {busy ? "Creating access…" : method === "email" ? "Send email invite" : "Create temporary login"}
      </button>
    </form>
  );
}

function Credential({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="credential-row">
      <span><small>{label}</small><code>{value}</code></span>
      <button type="button" className="btn btn-quiet btn-small" onClick={onCopy}>Copy</button>
    </div>
  );
}
