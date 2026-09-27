---
issue: 170
section: Fixed
---

- Documentation's mined business rules now include conditions written across
  several lines (`if`, `when`, ternary, precondition, elvis, thrown error, zod
  chain, SAS `IF`/`WHERE`, SQL `CHECK`/`WHERE`/`IF ... THEN`), read whole and
  reported at their first line in every supported language. A comment inside
  a Kotlin `when` is no longer read as part of an arm.
- In Kotlin, a call to a capitalised name counts as constructing an object only
  when the project declares a Kotlin or Java class of that name, including on
  an incremental refresh. Compose calls such as `Column { }` and `Text("...")`
  are now recorded as function calls, not object creation.
