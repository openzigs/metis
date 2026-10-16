---
issue: 1175
section: Added
---

- `DOCS_GEN_BRD_LAYOUT=reader` (new, **off by default**): a Business Requirements document
  generated from code opens with a main document of about 12–18 pages for the people who
  sign it off (Executive Summary, Scope, Core Business Capabilities, Key Business Rules, and
  requirements reconstructed from the code, labelled as such, with acceptance criteria),
  followed by an appendix with the module-by-module detail. The main part is held to about
  60,000 characters; anything it leaves out is listed. Unset, a BRD is generated as before.
- The walkthrough scores the BRD on a sign-off rubric as well as the answer key.
