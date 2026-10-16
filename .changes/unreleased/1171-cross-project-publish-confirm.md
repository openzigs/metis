---
issue: 1171
section: Fixed
---

- Publishing to a repository another project connects now asks for confirmation on the Publish page, instead of failing with an instruction to pass an API flag. The dialog names the other project only when you can open it.
- A dry run is no longer refused. It notes that the live publish will ask, and a dry-run batch can never be published live later.
- The batch form falls back to the project's saved publish target.
