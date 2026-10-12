/**
 * #1064 — the publish batch form's "GHE base URL" field, as Generate sends it.
 *
 * Generate reads the field only to learn which HOST the drafts are for (code is
 * linked only when host, owner and repository are the analysed repository's).
 * It is a free-text field that belongs to another card, so whatever it holds
 * must not make Generate fail:
 *   - empty, or only spaces  → `null`: public GitHub;
 *   - an https URL           → that URL, trimmed;
 *   - anything else (half-typed, `github.example.com`, `http://…`) → sent as
 *     typed. The server reads it as naming no host and lists the code as text;
 *     `problem` says so, for the user.
 */
export interface GenerateTargetBaseUrl {
  /** What to send as `targetBaseUrl`. */
  value: string | null;
  /** Why the drafts will list code as text, when the field is the reason. */
  problem: string | null;
}

export const BASE_URL_NOT_HTTPS =
  "The GHE base URL in the publish batch form is not an https URL, so these drafts list code as " +
  "text, not links. Correct the field (or clear it for github.com) and generate again to get links.";

export function isHttpsUrl(text: string): boolean {
  try {
    return new URL(text).protocol === "https:";
  } catch {
    return false;
  }
}

export function generateTargetBaseUrl(field: string): GenerateTargetBaseUrl {
  const value = field.trim();
  if (value === "") return { value: null, problem: null };
  return { value, problem: isHttpsUrl(value) ? null : BASE_URL_NOT_HTTPS };
}
