---
issue: 870
section: Security
---

- The user search behind the @mention and assignee pickers no longer lists every
  active user in every workspace. Without a project, it now offers only users who
  share a workspace with you, plus system admins; a system admin still sees
  everyone. The assignee picker now searches within the requirement's project.
