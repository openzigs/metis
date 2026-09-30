---
issue: 448
section: Fixed
---

- The New project wizard now says why a project's repository was not linked (for example, a vault
  secret that does not exist) instead of a generic "could not be connected", with a button to
  open the project's Connections page. The Create form's warning no longer repeats the
  Connections hint, and both warnings stay on screen for 10 seconds rather than about 4.
- A failure while marking a project's first repository as primary can no longer leave a
  connector behind that the create reported as failed.
