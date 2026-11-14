---
issue: 2446
section: Added
---

- Analyses now record which documents and repository files each finding, citation, requirement
  and cross-document finding drew on, as ids only. Nothing you see changes yet: this is what a
  later release uses to hide only the parts of a result a reader may not see. Analyses run before
  this release record nothing and keep today's rule, where everything in a result is shared with
  the whole project.
