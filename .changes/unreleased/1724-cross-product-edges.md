---
issue: 1724
section: Added
---

- **Generate Documentation** now also finds the edges between a product's repositories
  and those of the other products in its workspace that you can access, so separate
  products such as Orders, Billing and Notify are linked without an umbrella product.
- **Declare edge** can point at another product's repository in the same workspace, and
  two products that each declare a resource of the same kind and name are linked through
  it in the impact check. Repositories you cannot access are never read or shown.
