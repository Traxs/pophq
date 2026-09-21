// What a signed-in person may change about POP HQ itself, as opposed to alliance data.
// The API remains the authority: every section here is refused server-side for the wrong role.

export interface SettingsSection {
  id: string;
  title: string;
  /** One line under the heading, so a section explains itself before it is opened. */
  blurb: string;
}

export const ACCOUNTS_SECTION: SettingsSection = {
  id: "accounts",
  title: "Your game accounts",
  blurb: "The accounts linked to this sign-in. An officer links an alt after checking its Player ID.",
};

export const BOTS_SECTION: SettingsSection = {
  id: "bots",
  title: "Bot access",
  blurb: "Tokens that let a bot read POP HQ for you, and optionally prepare changes you approve.",
};

/**
 * Bot tokens inherit the issuer's access, so only officers and owners may hold one. Hiding the
 * section for everyone else is a courtesy, not the control: the API refuses it either way.
 */
export function canManageBots(groups: readonly string[]): boolean {
  return groups.includes("officer") || groups.includes("owner");
}

export function sectionsFor(groups: readonly string[]): SettingsSection[] {
  return [ACCOUNTS_SECTION, ...(canManageBots(groups) ? [BOTS_SECTION] : [])];
}
