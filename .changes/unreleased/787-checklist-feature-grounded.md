---
issue: 787
section: Fixed
---

- Spec Kit `speckit.checklist` now writes each domain's checklist from the feature's own `spec.md`
  and `plan.md`, in one call to the project's AI provider, instead of the same fixed items for every
  feature. When there is no online provider, or the model returns nothing for a domain, that file
  falls back to the old default items and says at the top that it is a generic template.
- Re-running `speckit.checklist` in `merge` mode (the default) no longer deletes the items a
  reviewer added to a checklist. Their own lines and tick marks are kept below the regenerated items.
