---
issue: 1636
section: Fixed
---

- An impact run whose projects were all skipped now says no project was checked, with the reasons open, instead of "No code impact detected". A deleted project reads **Not checked: project deleted**, and a restricted one is labelled as a project the run's starter could not access.
- Applying a withheld re-synthesis showed no change for a requirement it only reclassified, yet wrote the new kind. The comparison now lists **Kind** changes, and a result that gives no kind keeps the current one.
- The Markdown analysis report names the repository of each cited location, so the same path in two repositories no longer prints as two identical lines. "Partially implemented" now reads "Partly implemented", as on the page.
- The **Kind** filter is hidden on runs with no classified requirement, and non-functional categories read as labels ("Security", not "security").
