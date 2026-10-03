---
issue: 813
section: Changed
---

- The code graph decides whether a file or symbol is a test, and what it
  tests, from one per-language table (Go, TypeScript/JavaScript, Python,
  Java/Kotlin/Scala, C#, Rust). Impact analysis, the traceability matrix and
  the code overview give exactly the answers they gave before; this is the
  groundwork for showing which tests cover a symbol.
