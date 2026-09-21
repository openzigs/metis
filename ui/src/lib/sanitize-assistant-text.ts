/**
 * #1369 — internal tool-call protocol must never render as assistant prose.
 *
 * Observed verbatim in one answer, three separate leaks at once:
 *
 *   <br>{"name": "bash", "input": {"command": "grep -rn …", "description": "…"}}
 *   Tool ran without output or approval to run.
 *   system<system_notification>Bash command completed with empty output</system_notification>
 *
 * `stripToolTags` (#718) handles `<tool_call>` XML at the DELTA level, but a
 * frame like the one above is multi-line and arrives split across deltas, so it
 * cannot be recognised chunk-by-chunk. This runs at RENDER time on the fully
 * accumulated message, which is the only place the whole frame exists.
 *
 * Deliberately narrow and fence-aware. Inside a fenced code block nothing is
 * touched at all — a user asking "show me the JSON a tool call looks like" gets
 * their answer intact.
 */

/** `system<system_notification>…</system_notification>`, envelope and all. */
function stripSystemNotifications(text: string): string {
  if (text.indexOf("system_notification") === -1) return text;
  const OPEN = "<system_notification>";
  const CLOSE = "</system_notification>";
  let out = "";
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(OPEN, i);
    if (start === -1) {
      out += text.slice(i);
      break;
    }
    // The provider prefixes the envelope with a bare `system` token; drop it too.
    let head = text.slice(i, start);
    if (head.endsWith("system")) head = head.slice(0, -"system".length);
    out += head;
    const end = text.indexOf(CLOSE, start + OPEN.length);
    if (end === -1) {
      // Unterminated — drop the opening tag only, keep any trailing prose.
      i = start + OPEN.length;
      continue;
    }
    i = end + CLOSE.length;
  }
  // Any orphaned half of the pair that survived the scan above.
  return out.split(OPEN).join("").split(CLOSE).join("");
}

/** Toggle state for a ```/~~~ fenced block. */
function isFence(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

/** `<br>` / `<br/>` / `<br />` outside fences become real line breaks. */
function normaliseLiteralBreaks(text: string): string {
  if (text.toLowerCase().indexOf("<br") === -1) return text;
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (isFence(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      // A GFM table cell has no other way to hold a line break, and splitting
      // the row would stop the table rendering as a table. Leave those alone —
      // the markdown renderer handles them.
      if (isTableRow(line)) return line;
      return line.replace(/<br\s*\/?>/gi, "\n");
    })
    .join("\n");
}

/** `| a | b |` — a GFM table row or its delimiter. */
function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 1;
}

/**
 * A line that is nothing but a tool-call frame, e.g.
 * `{"name": "bash", "input": {…}}`. Requires BOTH the `name` key at the start
 * and an `input`/`arguments` key, so ordinary JSON a user pasted — or that the
 * model produced as an example — is not swallowed.
 */
function isToolFrameLine(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("{")) return false;
  if (!/^\{\s*"name"\s*:/.test(t)) return false;
  return /"(?:input|arguments|parameters)"\s*:/.test(t);
}

/** Protocol boilerplate the runtime emits around a tool call. */
const TOOL_BOILERPLATE = new Set([
  "Tool ran without output or approval to run.",
  "Tool ran without output.",
]);

function stripToolFrameLines(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .filter((line) => {
      if (isFence(line)) {
        inFence = !inFence;
        return true;
      }
      if (inFence) return true;
      return !isToolFrameLine(line) && !TOOL_BOILERPLATE.has(line.trim());
    })
    .join("\n");
}

/**
 * Remove leaked tool-call protocol from an assistant message before it is
 * rendered. Ordinary prose, markdown and fenced code are returned unchanged.
 */
export function sanitizeAssistantText(text: string): string {
  if (!text) return text;
  let out = stripSystemNotifications(text);
  out = normaliseLiteralBreaks(out);
  out = stripToolFrameLines(out);
  // Collapse the run of blank lines a removed frame leaves behind, so the
  // surrounding paragraphs do not drift apart.
  return out.replace(/\n{3,}/g, "\n\n");
}
