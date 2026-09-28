const PRIVATE_LOGIN_SUFFIX = "@members.pophq.invalid";

/** Cognito requires an email-shaped identifier; players only need their chosen login name. */
export function displayLoginName(identifier: string): string {
  return identifier.toLowerCase().endsWith(PRIVATE_LOGIN_SUFFIX)
    ? identifier.slice(0, -PRIVATE_LOGIN_SUFFIX.length)
    : identifier;
}

/** Resolve a friendly password username while leaving real email-code addresses unchanged. */
export function cognitoLoginIdentifier(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.includes("@") ? normalized : `${normalized}${PRIVATE_LOGIN_SUFFIX}`;
}
