---
issue: 170
section: Fixed
---

- Documentation's mined business rules now include conditions written across
  several lines. An `if`, `when`, ternary, precondition, elvis guard, thrown
  error, zod chain, SAS `IF`/`WHERE` or SQL `CHECK`/`WHERE`/`IF ... THEN` that
  spans lines used to yield no rule or a truncated fragment; it is now read
  whole and reported at its first line, in every language the rule miners
  support. Every rule found before is still found.
- In Kotlin, a call to a capitalised name counts as constructing an object only
  when the project declares a Kotlin or Java class of that name. Compose calls
  such as `Column { }` and `Text("...")` are now recorded as function calls, so
  the code graph of a Compose UI no longer shows them as object creation.
