---
issue: 1583
section: Fixed
---

- Spec Kit commands show one toast each. A finished or cancelled command no longer shows its toast
  twice. A command refused by a phase gate no longer adds the generic "The Spec Kit operation
  failed. Please try again." toast.
- A phase-gate refusal names every artifact the feature is missing, and the command to run first.
  `/speckit.implement` on a feature with only `spec.md` now says it has no `plan.md` or `tasks.md`
  yet and to run `/speckit.plan`. Before, it named only `tasks.md`.
- The `/speckit.plan` result card's Check line no longer flags a plan that says a file's source
  was not shown when the context only named that file. It still flags a plan that calls a file on
  the context list absent, or says it could not see a file whose source it was given.
- An analysis started from a Spec Kit handoff titles each requirement by its own label (`AC-1`,
  `NFR-1`). Before, the run's Summary titled the first one with the handoff's preamble.
- An over-size artifact save now says `content is too long: at most 200,000 characters` instead of
  returning raw validation JSON. Other refused Spec Kit request bodies are also described in words.
- New Spec Kit feature slugs are at most 48 characters after the number. Slugs made from a pasted
  issue used to be 60 to 72 characters. Existing slugs do not change.
