---
issue: 1724
section: Added
---

- Products in the same workspace are now linked by detected edges. **Generate
  Documentation** on a product also pairs its repositories with the repositories of the
  other products in its workspace that you can access. Orders, Billing and Notify can be
  three products of one repository each, and the edges between them are still found.
  Before this, detection only looked inside one product, so separate products had no
  detected edges between them.
- You can declare an edge to a repository of another product in the same workspace. The
  **Declare edge** dialog lists those repositories under *Other products in this
  workspace*, and the product page labels them with their product's name.
- Two products that each declare a shared resource of the same kind and name, such as a
  topic, are linked through it in the portfolio impact check. A change to Orders now
  reaches Billing directly and Notify two hops away, with no umbrella product.
- Repositories you cannot access, and products in other workspaces, are never read or
  shown, as before.
