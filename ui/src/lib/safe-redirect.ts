/**
 * Validate a `?next=` redirect target so we never honour an open-redirect.
 *
 * Accepts only same-origin paths:
 *   - must start with a single `/`
 *   - must NOT start with `//` (protocol-relative URL → off-origin)
 *   - must NOT start with `/\` or `/%5C` (browser-normalised backslash trick)
 *   - must NOT contain a scheme, `\r`, `\n`, or other control chars
 *   - must parse as a relative URL whose pathname starts with `/`
 *
 * Returns the input on success, `fallback` otherwise.
 */
export function safeRedirectPath(next: unknown, fallback = "/dashboard"): string {
  if (typeof next !== "string" || next.length === 0) return fallback;

  // Reject anything that isn't a clean leading slash.
  if (next[0] !== "/") return fallback;

  // Protocol-relative or backslash-host tricks: //evil.com, /\evil.com, /%5Cevil.com
  if (next.startsWith("//") || next.startsWith("/\\") || next.toLowerCase().startsWith("/%5c")) {
    return fallback;
  }

  // Disallow embedded control chars that could enable header-splitting style attacks
  // once the value is round-tripped through Location/router APIs.
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;

  // Final sanity check: parse as a URL relative to a synthetic origin and require
  // (a) the resulting origin equals the synthetic one and (b) the pathname starts
  // with `/`. This catches anything URL parsing would normalise into a host change.
  try {
    const parsed = new URL(next, "https://metis.invalid");
    if (parsed.origin !== "https://metis.invalid") return fallback;
    if (!parsed.pathname.startsWith("/")) return fallback;
  } catch {
    return fallback;
  }

  return next;
}
