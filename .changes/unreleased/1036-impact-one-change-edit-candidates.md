---
issue: 1036
section: Changed
---

- Impact analysis reads a pasted issue as one change instead of one "requirement" per heading,
  finds code with the same search chat uses, and reports two lists: a short **Files to edit** and
  a wider **Blast radius** to review. Empty form fields, bare links, version fields and sign-offs
  are left out. The API item gains `editCandidateFiles` and `blastRadiusFiles`; the markdown
  export has the same two sections.
