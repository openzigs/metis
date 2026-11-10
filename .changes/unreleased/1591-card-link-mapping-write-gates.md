---
issue: 1591
section: Fixed
---

- On the Analysis page, a user without the `project.update` permission (for example a developer)
  now sees a requirement's "Add link" and "Unlink", and the duplicate warning's "Mark as
  duplicate" and "Not a duplicate", disabled with the hint "Requires project.update". A user
  without `connector.write` sees the data mappings' "Add mapping", "Suggest mappings" and
  "Remove" disabled with the hint "Requires connector.write". Before, each was offered and the
  server refused it only after the user acted. The assignee search, the add-link dialog and the
  mapping form now also close if the user loses the permission while one is open.
