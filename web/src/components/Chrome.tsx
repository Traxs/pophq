import { useEffect, useState } from "react";
import { initials } from "../format";
import { roleLabel } from "../rules";
import { navigate, usePath } from "../router";
import { useSession } from "../session";
import { Sheet } from "./Sheet";

export function TopBar() {
  const { me, account, setActing, signOut } = useSession();
  const [open, setOpen] = useState(false);

  return (
    <header className="topbar">
      <a
        href="/"
        className="brand"
        onClick={(e) => {
          e.preventDefault();
          navigate("/");
        }}
      >
        <span className="brand-mark" aria-hidden="true">
          ❄
        </span>
        POP HQ
      </a>

      {account ? (
        <button type="button" className="account-chip" onClick={() => setOpen(true)} aria-haspopup="dialog">
          <span className="avatar" aria-hidden="true">
            {initials(account.name)}
          </span>
          <span className="account-chip-text">
            <span className="account-chip-name">{account.name}</span>
            <span className="account-chip-sub">{roleLabel(me?.groups ?? [], account.rank, account.alliance)}</span>
          </span>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      ) : (
        <button type="button" className="text-btn" onClick={signOut}>
          Sign out
        </button>
      )}

      <Sheet open={open} title="Your game accounts" onClose={() => setOpen(false)}>
        <ul className="account-list">
          {me?.accounts.map((a) => (
            <li key={a.playerId}>
              <button
                type="button"
                className="account-row"
                aria-current={a.playerId === account?.playerId}
                onClick={() => {
                  setActing(a.playerId);
                  setOpen(false);
                }}
              >
                <span className="avatar" aria-hidden="true">
                  {initials(a.name)}
                </span>
                <span className="account-row-text">
                  <strong>{a.name}</strong>
                  <span className="muted">
                    {a.playerId} · {a.alliance}
                    {a.rank ? ` · ${a.rank}` : ""}
                  </span>
                </span>
                {a.playerId === account?.playerId && (
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-label="Selected">
                    <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>
        <p className="muted small">Alts are linked by an officer after they check the Player ID.</p>
        <button type="button" className="btn btn-quiet btn-block" onClick={signOut}>
          Sign out
        </button>
      </Sheet>
    </header>
  );
}

interface Tab {
  path: string;
  label: string;
  icon: string;
}

const TAB_HOME: Tab = { path: "/", label: "Home", icon: "M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z" };
const TAB_POWER: Tab = { path: "/power", label: "Power", icon: "M13 3L5 14h6l-1 7 8-11h-6z" };
const TAB_MEMBERS: Tab = {
  path: "/members",
  label: "Members",
  icon: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14a6 6 0 0 1 3.5 6",
};
const TAB_DEV: Tab = {
  path: "/dev",
  label: "Dev",
  icon: "M14.5 5.5a4 4 0 0 0-5 5L4 16v4h4l5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z",
};

export function TabBar() {
  const path = usePath();
  const { isOfficer } = useSession();
  const tabs = [TAB_HOME, TAB_POWER, ...(isOfficer ? [TAB_MEMBERS] : []), ...(import.meta.env.DEV ? [TAB_DEV] : [])];
  return (
    <nav className="tabbar" aria-label="Main">
      {tabs.map((t) => (
        <a
          key={t.path}
          href={t.path}
          className="tab"
          aria-current={path === t.path ? "page" : undefined}
          onClick={(e) => {
            e.preventDefault();
            navigate(t.path);
          }}
        >
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
            <path d={t.icon} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t.label}
        </a>
      ))}
    </nav>
  );
}

export function OfflineBanner() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  if (online) return null;
  return (
    <div className="banner banner-warn" role="status">
      You're offline. Changes can't be saved until you're back online.
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner banner-error" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="text-btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
