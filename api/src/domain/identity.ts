import { ValidationError } from "./errors.js";

// Invisible and control characters used to smuggle text past humans
// (zero-width, bidi overrides, Unicode "tag" characters, C0/C1 controls).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]|[\u{e0000}-\u{e007f}]/u;

const PLAYER_ID = /^[1-9][0-9]{4,14}$/;

/** Validates an in-game Player ID: digits only, 5–15 long, no leading zero. */
export function parsePlayerId(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  if (!PLAYER_ID.test(value)) {
    throw new ValidationError("Player ID must be 5–15 digits without a leading zero.");
  }
  return value;
}

/**
 * Validates an in-game name as entered (raw spelling is kept).
 * Rejects invisible and control characters; length 2–30 after NFKC normalisation.
 */
export function parseGameName(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("Name is required.");
  const name = raw.normalize("NFKC").trim();
  if (FORBIDDEN_CHARS.test(name)) {
    throw new ValidationError("Name contains invisible or control characters.");
  }
  const length = [...name].length;
  if (length < 2 || length > 30) throw new ValidationError("Name must be 2–30 characters.");
  return name;
}

/** Search form of a name: NFKC, case-folded, whitespace collapsed. Never shown to users. */
export function searchKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
