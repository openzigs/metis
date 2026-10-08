---
issue: 788
section: Fixed
---

- Spec Kit **Generate constitution.md** now writes a real constitution. It retrieves the project's
  README, contributing guide, dependency manifests and similar ingested documents, and the project's
  AI provider writes the principles from them, each naming its source. The result is versioned like
  a `/speckit.constitution` write. When nothing relevant has been ingested, or no AI provider is
  configured, it still writes the empty skeleton, but the page now says so and why, as a warning.
- `/speckit.constitution` now uses the `Version:` you declare in the body when it is higher than
  the automatic bump, and the stored file always shows the version that was recorded.
- Removed the `speckit.constitution.write` permission. It never decided anything: every role that
  can update a project already had it, and writing the constitution still requires `project.update`.
