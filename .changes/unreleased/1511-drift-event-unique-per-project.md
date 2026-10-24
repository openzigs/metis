---
issue: 1511
section: Fixed
---

- A GitHub issue event that reaches two projects' issue webhooks now records drift in both. Drift events were unique on GitHub's delivery GUID alone, which every subscribed webhook shares, so the second project's drift was dropped as a duplicate. They are now unique per project.
