---
issue: 2010
section: Fixed
---

- Governing findings are stricter about evidence. A finding is marked
  Compliant only when the model quotes real words from the requirement or an
  answer, and boilerplate such as "the system shall" no longer counts. A large
  analysis no longer loses all of its findings to a database timeout. When
  producing the findings again clears a business analyst's accept or reject
  decision, the audit log now records that. Findings of a rule that has since
  been deleted are kept, decision included. A cancelled analysis no longer
  writes findings. Answering a governing question no longer waits for the
  findings to refresh. Still behind the `GOVERNING_DOCS_ENABLED` setting, which
  is off by default.
