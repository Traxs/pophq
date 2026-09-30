export function RegistrationRolePicker({
  substitute,
  disabled,
  busy,
  onChange,
}: {
  substitute: boolean;
  disabled: boolean;
  busy: boolean;
  onChange: (substitute: boolean) => void;
}) {
  return (
    <div className="registration-role-picker">
      <span className="muted small">Signup role</span>
      <div className="registration-role-options" role="radiogroup" aria-label="Signup role">
        <button
          type="button"
          role="radio"
          aria-checked={!substitute}
          className={`registration-role-option${!substitute ? " is-selected" : ""}`}
          disabled={disabled || busy}
          onClick={() => onChange(false)}
        >
          <strong>Regular</strong>
          <span>Compete for a starting place</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={substitute}
          className={`registration-role-option${substitute ? " is-selected" : ""}`}
          disabled={disabled || busy}
          onClick={() => onChange(true)}
        >
          <strong>{busy ? "Saving…" : "Substitute"}</strong>
          <span>Put me on the substitute list</span>
        </button>
      </div>
    </div>
  );
}
