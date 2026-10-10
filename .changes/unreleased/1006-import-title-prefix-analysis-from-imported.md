---
issue: 1006
section: Added
---

- GitHub import can keep only issues whose title starts with a given prefix,
  such as `[Feature]:`, for repositories that mark feature requests in the title
  rather than with a label. The prefix is removed from the imported title.
- A new analysis can start from imported requirements. Pick them in the new
  "Analyze imported requirements" list. Each one you pick is analyzed as its own
  requirement, and the run's summary lists each one with a link back to the
  original GitHub, Jira, Azure DevOps or Linear item. The list's filter searches
  every imported requirement by title or issue number, and says when only the
  newest are shown.
