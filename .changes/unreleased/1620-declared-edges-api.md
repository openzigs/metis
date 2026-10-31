---
issue: 1620
section: Added
---

- Analysts and architects can record couplings that detection misses: declare,
  change and delete a product's edges and shared resources (an identity
  provider, a nightly batch table) through `/api/products/:id/edges` and
  `/resources`. A detected edge cannot be deleted, since detection would find
  it again; override its strength instead, which keeps the change on re-runs.
  A resource locator may not hold credentials.
