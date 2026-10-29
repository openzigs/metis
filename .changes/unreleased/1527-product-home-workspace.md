---
issue: 1527
section: Security
---

- Products: a product now belongs to one home workspace, recorded when the first repo its creator could have attached is attached. A repo from another workspace no longer opens the product to that workspace's members, including on a product an admin created. Removing the creator from the workspace, or taking away their admin role, no longer hides their products from the team. The product list no longer fails once a member can reach more than about 1,000 projects. Existing products are given a home by the upgrade, from their earliest-attached repo that their creator could have attached.
