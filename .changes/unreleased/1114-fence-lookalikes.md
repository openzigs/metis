---
issue: 1114
section: Security
---

- Analysis prompts and tool results now redact text that only looks like the
  `===METIS-DATA-BOUNDARY===` fence: full-width equals signs, zero-width or
  bidi characters inside the label, hyphen look-alikes and homoglyphs from
  other scripts. Text without a fence look-alike reaches the model unchanged.
- The fence scrub is linear in its input; the previous pattern was quadratic
  on a long run of `=` signs.
