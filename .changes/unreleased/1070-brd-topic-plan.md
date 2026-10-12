---
issue: 1070
section: Changed
---

- `DOCS_GEN_TOPIC_PLAN` (new, **off by default**): a Business Requirements document can be
  planned before it is written. Off, a BRD is generated exactly as before and nothing is
  rewritten on upgrade.
- Turned on, the document's length is shared among sections and topics up front and each
  prompt states its share; a module that cannot fit is left out by priority and listed; and
  when a length limit is exceeded each part loses its own tail instead of the section its
  last topics, the document as a whole never keeping less than without a plan. Constants
  and formulas read from the source are given to the sections that mention or own them, and
  a note says where the document states one differently. No model call is added.
- Turning it on rewrites every section of an existing BRD once, on its next generation.
