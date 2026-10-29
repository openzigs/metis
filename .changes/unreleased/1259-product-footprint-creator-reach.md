---
issue: 1259
section: Security
---

- Products: a repo attached from another workspace no longer lets that workspace's members open the product, its analysis history or its documents. An attached repo now grants access only when the product's creator could have attached it: the creator is an admin, or a member of the repo's workspace, or the repo has no workspace.
