---
issue: 1289
section: Security
---

- A merged pull request now marks a requirement as implemented only when the
  requirement's issue was published to GitHub in the same repository as the pull
  request. Owner and name are compared case-insensitively. Before this change, a
  pull request in one workspace's repository that said "Closes #5" could mark
  another project's requirement #5 as implemented, including a Jira issue numbered 5.
- If a repository is renamed or transferred on GitHub after its issues were
  published, pull requests merged under the new name do not link those issues.
