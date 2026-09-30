---
issue: 383
section: Fixed
---

- Code Discovery finds embedded SQL and stored-procedure calls in `.tsx`
  components. SQL-string extraction still scanned `.tsx` files with the plain
  TypeScript grammar, in which JSX is invalid, so a literal next to JSX text such
  as a URL could vanish into a mis-parsed comment. Every grammar lookup now goes
  through the same per-file selector that code-graph parsing uses.
