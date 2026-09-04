export function isValidEmailForLanding(email: string): boolean {
  if (!email) return false;
  if (email.includes(" ")) return false;
  const atIdx = email.indexOf("@");
  if (atIdx < 1) return false;
  if (email.lastIndexOf("@") !== atIdx) return false;
  const domain = email.slice(atIdx + 1);
  if (!domain) return false;
  if (domain.startsWith(".")) return false;
  if (domain.endsWith(".")) return false;
  if (domain.includes("..")) return false;
  if (!domain.includes(".")) return false;
  return true;
}

export type EmailValidationFailureReason = "empty" | "missing_at" | "invalid_domain";

export function classifyEmailValidationFailure(email: string): EmailValidationFailureReason {
  if (!email) return "empty";
  const atIdx = email.indexOf("@");
  if (atIdx < 1) return "missing_at";
  return "invalid_domain";
}
