---
issue: 1259
section: Security
---

- Products: a repo attached from another workspace no longer lets that workspace's members open the product, its analysis history or its documents. An attached repo now counts towards who can open a product only when the product's creator could have attached it (the creator is an admin or a member of the repo's workspace, or the repo's project has no workspace). A product's bound projects count as before, and so does an admin-created product's every repo; a product whose creator was removed from the repo's workspace is now visible to admins only.
