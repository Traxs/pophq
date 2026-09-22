import type { InviteResult } from "./api";

/** Plain summary of what an invite actually changed; repeating an invite is allowed. */
export function summarise(res: InviteResult): string {
  const name = res.account.name;
  if (res.credentials) return `${name}'s temporary login is ready`;
  if (res.loginCreated && res.linked) return `${name} can sign in now`;
  if (res.linked) return `${name} linked to an existing login`;
  if (res.accountCreated) return `${name} added without a login`;
  return `${name} was already set up`;
}
