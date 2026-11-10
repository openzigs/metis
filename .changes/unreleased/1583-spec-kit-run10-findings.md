---
issue: 1583
section: Fixed
---

- Spec Kit commands show one toast each, and a phase-gate refusal no longer adds a generic failure
  toast. A gate refusal names every missing artifact and the command to run first.
- The `/speckit.plan` Check line no longer flags a plan for saying it was not shown the source of
  a file the context only named.
- A Spec Kit handoff's requirements are titled by their own labels (`AC-1`), not by its preamble.
- An over-size artifact save says the limit in words instead of returning raw validation JSON.
- New feature slugs are at most 48 characters after the number.
