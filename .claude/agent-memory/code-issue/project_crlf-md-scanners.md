---
name: crlf-md-scanners
description: A server-side Markdown line scanner must handle CRLF (normalise first, or anchor on \r?$ as ui/src/lib/markdown-sections.ts does); LF-only fixtures never catch it.
metadata:
  type: project
---

A line-by-line Markdown scanner on the server has to cope with CRLF line endings. Either normalise first with `text.replace(/\r\n?/g, "\n")`, or anchor every end-of-line pattern on `\r?$`, as `ui/src/lib/markdown-sections.ts` does.

**Why:** in PR #1179 (#1170), `nestBodyHeadings` in `server/src/lib/docs-gen/requirements-scope.ts` split on `\n` and matched a fence closer with `[ \t]*$`. On a CRLF body the closer line ends in `\r`, so the fence never closed, and everything after it was treated as code: `"```\r\ncode\r\n```\r\n## After"` kept `## After` at H2. The setext underline check failed the same way. Every fixture was LF-only, so the suite passed and the PR #1179 re-review (5548504686) caught it. Requirement bodies imported from trackers (GitHub, Jira) can carry CRLF.

**How to apply:**
- For any new scanner that splits Markdown into lines and tests a line with `$`, normalise at the top, and add at least one CRLF case for each construct it recognises (fence, heading, underline, marker).
- A single `split("\n")` that only compares whole-line text with `trim()` is safe. One that tests `$` is not.
- Related trap from the same PR: do not `trim()` a Markdown body before or after rewriting it. The first line's indent is meaningful, and `"\tcode\n---"` trimmed becomes a setext H2. Drop leading blank lines instead (`replace(/^(?:[ \t]*\n)+/, "")`) and then `trimEnd()`.
