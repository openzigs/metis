---
name: same-origin-href-check
description: A same-origin link check must judge the URL the browser will resolve, then re-judge the normalised string it hands back; prefix checks and a single parse are both bypassable (PR #1315, #104).
metadata:
  type: project
---

A "same-origin relative link" check must judge the link the way the browser resolves it, and then judge the string it returns a second time.

**Why:** two bypasses in two review cycles of PR #1315 (#104, notification links in the drawer):

- **Prefix checks only** (`startsWith('/')`, `!startsWith('//')`) let `'/\t/evil.com'` through: the URL parser drops tab and newline (and reads `\` as `/`), so it resolves to `https://evil.com/`.
- **One parse, normalised output.** Checking `new URL(href, origin).origin === origin` and then returning the parsed `pathname` can still emit a protocol-relative path: `'/.//evil.com'` and `'/%2e//evil.com'` resolve same-origin, but their pathname normalises to `'//evil.com'`, which an anchor opens on another host.

**How to apply:**

- Parse with `new URL(href, origin)` and compare `.origin`; then re-check the string you return (must start with `/`, not `//` or `/\`) and parse it again. `safeInAppHref` in `ui/src/lib/notifications.ts` is the reference.
- Test tab, newline, backslash, `/./`, `%2e` and dot-segment cases, not only `//host` and `javascript:`.
- Related: [[project_next-catch-all-segments-are-decoded]] (the proxy route's version of "decide on the resolved path").

**Folded here (retired from the index 2026-10-21; files unchanged):**

- [[next-catch-all-segments-are-decoded]] — Next catch-all segments are decoded: decide proxy policy on resolved pathname (#1069)
