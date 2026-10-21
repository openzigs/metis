---
issue: 1114
section: Security
---

- Analysis prompts and tool results now redact text that only looks like the
  `===METIS-DATA-BOUNDARY===` fence: full-width or other look-alike equals
  signs, zero-width or bidi characters inside the label, hyphen look-alikes,
  homoglyphs from other scripts, small capitals, HTML character references and
  one-sided fences. Text without a fence look-alike reaches the model unchanged.
- A fence inside a tool result is now replaced by `[REDACTED-FENCE]`, like
  everywhere else, instead of a quoted copy of the fence.
- The fence scrub is linear in its input; the previous pattern was quadratic
  on a long run of `=` signs.
