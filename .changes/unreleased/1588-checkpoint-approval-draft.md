---
issue: 1588
section: Security
---

- Approving the analysis approval checkpoint now produces approved requirements only for a user
  with the `project.update` permission (coordinator, admin). A developer can still approve the
  checkpoint of an analysis they ran, and the requirements still reach the Requirements hub, but as
  drafts for a coordinator to approve. The Approvals tab tells a developer so before they approve.
  A Regenerate re-creates the approved list as approved only when the checkpoint was approved
  with that permission and the user pressing Regenerate holds it too; a run the scheduler started
  re-creates it as drafts.
