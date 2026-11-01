---
issue: 1628
section: Added
---

- A product page now has an **Integration edges** section. It lists every edge between
  the product's repositories with its kind (API, event, database, shared library,
  identity), coupling strength, direction, whether detection found it or a person
  declared it, and its confidence, and can be filtered by kind. Architects and analysts
  with edit rights on the product can declare an edge detection cannot see (a shared
  identity provider, a nightly file drop, a rule duplicated by hand), edit or delete it,
  and declare the shared resource it goes through. A detected edge cannot be deleted,
  because the next detection run would find it again; its strength can be overridden
  instead. Anyone without edit rights sees the list read-only, marked **Restricted**.
