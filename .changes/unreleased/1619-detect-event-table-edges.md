---
issue: 1619
section: Added
---

- Product relationship detection now classifies every edge it finds (an API
  contract, a shared library, an event, a shared database) and finds two new
  kinds: one repo subscribing to a topic another publishes (from an AsyncAPI
  document or from client calls in code), and two repos whose SQL or code graph
  touch the same table, marked intrusive when either side writes it. Running it
  again changes nothing, and never alters an edge someone declared. Nothing
  runs it from the product page yet.
