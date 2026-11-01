---
issue: 1647
section: Fixed
---

- Product edges and shared resources are safer to edit: an edge can no longer
  name a resource or contract the caller cannot see, point a repo at itself, or
  duplicate an edge the product already has; overriding a detected edge or
  resource no longer unlocks it for moving or deleting; and every edge and
  resource change is now audited. Resource locators refuse more credential
  shapes (JDBC `password=`, `scott/tiger@`, `user:pass@host`).
- Edge detection makes fewer false couplings: UI text such as "Select from the
  list", `EXTRACT(... FROM col)`, CTE names, calls written inside strings or
  docstrings, and unresolved dynamic SQL tables no longer create edges, and a
  re-run no longer flips an edge's direction.
