---
issue: 789
section: Added
---

- The Spec Kit page now covers the whole Spec Kit workflow. A **Features** selector lists, archives
  and restores features and shows each feature's phase gates; the tree and viewer show that
  feature's own artifacts. The command palette offers the `speckit.*` commands, including
  `/speckit.constitution`, `/speckit.checklist` and `/speckit.taskstoissues`, and runs them on the
  selected feature. Buttons generate checklists, preview the issue export and publish it (after a
  dry run), and delete the viewed artifact. After `/speckit.implement`, **Start analysis with
  these artifacts** starts the analysis and opens it, instead of asking you to call the API.
- The Workbench chat no longer suggests `/specify`, `/plan` and the other Spec Kit commands. The
  chat never ran them; a picked command was sent to the model as an ordinary message.
