---
issue: 1727
section: Fixed
---

- A product's **Integration edges** update as soon as **Generate Documentation** finishes,
  without a reload. The run names any repository it skipped for having no clone yet, and a
  repository added on a project's **Connections** page now starts syncing when created.
- A type two repositories both export points at the one named for it (*billing* depends on
  *orders* for `Order`). The **Add Repo** picker hides repositories already in the product
  and shows each one's project. Service Map labels no longer break mid-name, and the Data
  Flow diagram counts the `imports` links it leaves out.
