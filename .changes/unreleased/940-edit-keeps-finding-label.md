---
issue: 940
section: Fixed
---

- Saving a requirement from its Edit dialog no longer drops the hidden `finding:<id>` label that
  links it to its source finding. `PUT /api/requirements/:id` now merges the labels the dialog
  sends with the hidden labels already stored, so traceability and the publish path keep working
  after an edit, and a client can no longer add or remove that link by sending labels.
