/**
 * #1869 — `sanitiseHtml` as it was before #1869, verbatim, kept as the oracle
 * the linear rewrite is compared with (`tests/sanitise-html-linear-1869.test.ts`).
 *
 * A fixture that exists to be bad: several of these regexes take quadratic time
 * on crafted input (CodeQL js/polynomial-redos), and their single-pass removals
 * are what CodeQL's multi-character-sanitization rules object to. That is why it
 * lives under `tests/fixtures/`, which the CodeQL config ignores. Never import it
 * from `src/`.
 */
export function referenceSanitiseHtml(html: string): string {
  let out = html;
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  out = out.replace(/<style\b[\s\S]*?<\/style\s*>/gi, "");
  out = out.replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, "");
  out = out.replace(/<object\b[\s\S]*?<\/object\s*>/gi, "");
  out = out.replace(/<embed\b[^>]*\/?>/gi, "");
  out = out.replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, "");
  out = out.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, "");
  out = out.replace(/(href|src)\s*=\s*"\s*(javascript|data):[^"]*"/gi, '$1=""');
  out = out.replace(/(href|src)\s*=\s*'\s*(javascript|data):[^']*'/gi, "$1=''");
  out = out.replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)\s*>/gi, "\n");
  out = out.replace(/<br\s*\/?>(?!\n)/gi, "\n");
  out = out.replace(/<[^>]+>/g, "");
  out = out
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
  out = out.replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return out.trim();
}
