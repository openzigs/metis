/**
 * Defense-in-depth stripping of hallucinated tool-tag markup (#718).
 *
 * The provider layer already converts inline `<tool_call>` / `<tool_response>`
 * XML into structured `tool_call` stream events. This is the belt-and-suspenders
 * fallback: if any residual markup still reaches the UI (e.g. an older server, or
 * a provider path we missed), we remove the specific tool tags before rendering
 * so users never see raw XML.
 *
 * Deliberately narrow: only the exact tool tags are stripped. Legitimate angle
 * brackets — `<div>`, generics like `Array<T>`, or anything inside a code block —
 * are left untouched. Scanning is `indexOf`-based (no backtracking regex), so it
 * cannot be driven into ReDoS.
 */
const PAIRS = [
  { open: "<tool_call>", close: "</tool_call>" },
  { open: "<tool_response>", close: "</tool_response>" },
] as const;

const ORPHAN_TAGS = ["<tool_call>", "</tool_call>", "<tool_response>", "</tool_response>"] as const;

/** Remove every `open…close` pair (and its contents) from `text`. */
function removePairs(text: string, open: string, close: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(open, i);
    if (start === -1) {
      result += text.slice(i);
      break;
    }
    result += text.slice(i, start);
    const end = text.indexOf(close, start + open.length);
    if (end === -1) {
      // No closing tag — drop only the open tag, keep the following text.
      i = start + open.length;
      continue;
    }
    i = end + close.length;
  }
  return result;
}

/** Strip tool-call / tool-response tags (and their contents) from a text run. */
export function stripToolTags(text: string): string {
  // Fast path: bail unless a tool tag could be present (covers both `<tool_`
  // opens and `</tool_` closes).
  if (!text || text.indexOf("tool_") === -1) return text;
  let out = text;
  for (const { open, close } of PAIRS) out = removePairs(out, open, close);
  // Remove any remaining orphaned tags (e.g. a stray closing tag).
  for (const tag of ORPHAN_TAGS) out = out.split(tag).join("");
  return out;
}
