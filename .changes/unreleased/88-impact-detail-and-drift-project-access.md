---
issue: 88
section: Fixed
---

- An in-flight impact-analysis run is no longer readable by someone outside its projects. A run
  with no results yet reported no projects at all, and the access check on the detail, export and
  Jira-publish routes skipped itself for a run naming none, so any holder of the analysis read
  permission could open, export or publish another team's running analysis by its id. The check
  now reads the project selection stored with the run, so it applies from the moment one starts.
  A run recorded before that selection existed stays readable by the person who started it and by
  administrators, rather than by everyone.
- The project drift list and the drift badge count now check that you can reach the project you
  asked about, not only that your role may read drift. Another project's id returns "not found",
  the same answer an unknown project gives.
