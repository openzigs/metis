---
issue: 1618
section: Added
---

- A product's cross-repo edges now say **what** crosses the boundary (an API,
  an event, a shared database, a shared library or an identity provider), **how
  tightly** the two sides are coupled, and whether detection found the edge or
  a person declared it. Shared tables, topics and identity providers become
  resources an edge can go through. `GET /api/products/:id` returns the edges
  and resources you can read; `POST /api/products/:id/edges` declares one.
