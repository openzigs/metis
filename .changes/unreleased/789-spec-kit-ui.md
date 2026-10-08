---
issue: 789
section: Added
---

- The Spec Kit page covers the whole workflow: a **Features** selector (list, archive, restore,
  phase gates), the `speckit.*` palette run on the selected feature, checklists, issue export
  after a dry run, artifact delete, and **Start analysis** after `/speckit.implement`.
- Without `project.update` the page is read-only: its write controls are disabled with "Requires
  project.update" instead of failing with 403.
- The Workbench chat no longer suggests `/specify`, `/plan` and the other Spec Kit commands. The
  chat never ran them; a picked command was sent to the model as an ordinary message.
