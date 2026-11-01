---
issue: 1623
section: Added
---

- A portfolio assessment now says which products a requirement affects: the
  products whose code must change (those that cover it in part, and the product
  you choose to host it when nothing covers it), and the products downstream of
  them through an API, event, shared table, shared library or shared identity.
  Each downstream product gets a severity (critical, high, medium or low) worked
  out from how tightly it is coupled, with the reasoning, the edges crossed, the
  call sites, the contract items and the shared tables stored alongside it. A
  product you cannot read shows only as restricted.
