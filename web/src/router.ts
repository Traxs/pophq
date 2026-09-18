import { useSyncExternalStore } from "react";

// Minimal history-based router: three routes don't justify a dependency.
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener("popstate", notify);

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (to === window.location.pathname + window.location.search) return;
  if (opts.replace) window.history.replaceState({}, "", to);
  else window.history.pushState({}, "", to);
  notify();
  window.scrollTo({ top: 0 });
}

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => window.location.pathname,
  );
}
