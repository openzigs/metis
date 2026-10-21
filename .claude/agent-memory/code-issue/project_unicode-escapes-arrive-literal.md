---
name: unicode-escapes-arrive-literal
description: A `\uXXXX` escape in Write/Edit content can land on disk as the literal character; build hostile Unicode with String.fromCodePoint and scan the file afterwards.
metadata:
  type: project
---

When writing a file through the Write or Edit tool, a backslash-u escape (backslash, `u`, four hex digits) inside a string or regex literal can land on disk as the **literal character**, not the escape. Seen on #1114: full-width test strings came back as literal full-width letters, a scanner regex for the line and paragraph separators (U+2028, U+2029) was written with the literal characters and no longer parsed ("missing /"), and this very memory file first landed with them too.

**Why it matters:** Semgrep blocks literal bidi characters in source, and a literal zero-width or bidi character is invisible in review. A fixture meant to say "U+202E" can silently become one.

**How to apply:**
- Build every invisible, bidi or look-alike character in source with `String.fromCodePoint(0x202e)` (or a `cp(...)` helper), never with a `\u` escape typed into the tool.
- For a regex property class in a throwaway script, use `new RegExp("[\\p{Cf}]", "gu")`.
- After writing, scan the touched files for `\p{Cf}`, `\p{Default_Ignorable_Code_Point}`, `\p{Zl}`, `\p{Zp}` code points before committing.

Related, same PR: the old fence pattern `/=+[\s_-]*M.../g` was quadratic on a long run of `=` (each start re-scans the run); `(?<!=)` before `=+` makes it linear. Any pattern that opens with `X+` needs the same check (`server/tests/helpers/linear-time.ts`).
