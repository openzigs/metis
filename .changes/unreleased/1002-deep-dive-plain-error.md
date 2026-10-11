---
issue: 1002
section: Fixed
---

- Deep Dive no longer fails with a raw parser error ("non-JSON output … at position 2019") when the
  model adds commentary after its draft. The draft is read even when prose containing braces
  follows it, an unreadable answer is asked for again once, and if that also fails the dialog shows
  a plain "could not be turned into an issue draft, please try again" message.
