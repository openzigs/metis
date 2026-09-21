/**
 * Robust JSON extraction for LLM structured-output responses (doc-gen grounding).
 *
 * BACKGROUND. The claim-extractor and faithfulness-judge both ask the model for a
 * single JSON object and previously parsed it with a one-shot
 * `content.replace(/^```(?:json)?…/).replace(/…```$/)` fence-strip + `JSON.parse`.
 * That happy path breaks whenever the model decorates the JSON despite being told
 * not to — e.g. a lead-in ("Here are the verdicts:"), a trailing sign-off, or a
 * ```json fence that is NOT the very first/last line. On the SAS `risk` doc this
 * produced repeated "Faithfulness judge batch was unparseable" warnings: the
 * affected batch was dropped, so its claims went uncounted and the section's
 * faithfulness ratio was deflated to a FALSE `degraded`.
 *
 * FIX. {@link extractFirstJson} keeps the fast fence-strip path, then falls back
 * to a string-aware balanced scan that pulls the first complete `{…}` or `[…]`
 * value out of surrounding prose. Braces inside JSON string literals (and escaped
 * quotes) are ignored by the scanner, so trailing prose containing a `}` cannot
 * truncate or over-capture the span. Returns the parsed value or `null`; never
 * throws. (Truncated output — a value with no matching close — still returns
 * `null`; non-streaming doc-gen calls use a 16K-token budget, so truncation of a
 * per-batch verdict list is not the failure mode this addresses.)
 */

/** Strip a single leading/trailing markdown code fence (the historical fast path). */
function stripFence(content: string): string {
  return content.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
}

/**
 * Scan from the first `{` or `[` and return the substring up to its matching
 * close, respecting double-quoted strings and backslash escapes so structural
 * characters inside string values are not counted. Returns `null` when there is
 * no opening bracket or no matching close (e.g. truncated output).
 */
function balancedSpan(content: string): string | null {
  let start = -1;
  let open = "";
  let close = "";
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "{" || ch === "[") {
      start = i;
      open = ch;
      close = ch === "{" ? "}" : "]";
      break;
    }
  }
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return content.slice(start, i + 1);
    }
  }
  return null; // no matching close — truncated/unbalanced
}

/**
 * Extract and parse the first JSON value from a possibly fenced / prose-wrapped
 * LLM response. Returns the parsed value, or `null` if none can be recovered.
 * Never throws.
 */
export function extractFirstJson(content: string): unknown | null {
  if (typeof content !== "string" || content.trim().length === 0) return null;

  // 1. Fast path: clean JSON or a single ```json fence.
  try {
    return JSON.parse(stripFence(content).trim());
  } catch {
    // fall through to the tolerant scan
  }

  // 2. Tolerant path: pull the first balanced {…}/[…] out of surrounding prose.
  const span = balancedSpan(stripFence(content));
  if (span === null) return null;
  try {
    return JSON.parse(span);
  } catch {
    return null;
  }
}
