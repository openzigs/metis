---
issue: 1576
section: Fixed
---

- A published sub-issue now names its parent epic by number and link (for example
  `([#15](https://github.com/acme/flux/issues/15))`) when the epic is created in the same publish
  batch. Before, the **Parent epic** line gave only the epic's title, although the sub-issue was
  attached to the epic on GitHub. The dry-run plan still shows the line without the number,
  because the epic does not exist yet when the plan is made.
