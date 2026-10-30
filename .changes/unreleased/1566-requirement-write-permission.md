---
issue: 1566
section: Security
---

- Editing, approving or rejecting a requirement now needs the `project.update` permission on both
  requirement write routes. `PATCH /api/analyses/:id/requirements/:reqId` needed only
  `analysis.run`, so a `developer` could make there the changes that `PUT /api/requirements/:id`
  refuses them. On the Analysis page, a user without the permission sees Edit, Approve and Reject
  disabled, with the hint "Requires project.update", instead of a dialog that ends in an error.
