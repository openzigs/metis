---
issue: 1727
section: Fixed
---

- A product's **Integration edges** section now updates as soon as **Generate Documentation**
  finishes. It used to read "No integration edges yet." until the page was reloaded. The page
  also says that the button detects the edges.
- **Generate Documentation** names the product's repositories it could not analyse because
  they have no clone yet, instead of skipping them silently. A repository added on a
  project's **Connections** page now starts syncing when it is created, not only the
  project's first one.
- When two repositories export a type of the same name from a types folder, the edge now
  points at the repository named for it. *Billing* depends on *orders* for `Order`, not the
  other way round.
- The **Add Repo** picker on a product leaves out repositories already in the product, shows
  each one's project and workspace, and still lists the row you picked after it fills the
  search field.
- Service Map node labels no longer break in the middle of a repository's name. The Data Flow
  diagram says how many `imports` links it leaves out.
