---
issue: 1351
section: Security
---

- Requirement text in the traceability and impact-analysis prompts can no longer close its own `<<<REQUIREMENT>>>` block with a forged `<<<END REQUIREMENT>>>`, a Unicode or HTML-entity look-alike, or a run of angle brackets. Clean requirement text reaches the model unchanged.
