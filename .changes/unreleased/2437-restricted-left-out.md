---
issue: 2437
section: Added
---

- An analysis now says when it left restricted files out. Its results are shared with the whole
  project, so it reads only what everyone on the project may see; the change request, and the
  Spec Kit handoff summary for a run started from one, now show a line such as "3 restricted files
  weren't analysed: results are shared with the whole project, so they include only what everyone
  on it can see." Only the count is shown and stored, never which files. A run that left nothing
  out shows nothing.
