---
issue: 2272
section: Added
---

- The portfolio check can now check a document. **Check requirements across portfolio** on a
  project's Documents page reads the document and checks each requirement in it on its own,
  where before a whole FRD was one requirement, cut at 8,000 characters, split into at most 8
  criteria and searched on its first 4,000. With the document reader on
  (`ANALYSIS_DOCUMENT_READER`), the model reads the document and each requirement, constraint
  or business rule it finds is checked; with it off, the document is split by paragraph and
  bullet, and the check says so. **Requirements checked** lists each one with the products
  found implementing it.
- A check can now look at several chosen products (up to 50), not only one or all of them.
- Nothing is cut silently any more: **Not checked**, on the check's page and in its Markdown
  export, lists every requirement past the 100 one check takes, text past what one check
  reads, a section the model could not read, dropped statements and repositories the budget
  ran out before, each with why. Every criterion is now searched for, however long the
  requirement: criteria that do not fit one search are searched in groups.
- Each product the change reaches says how sure the impact is: **Verified by graph path**,
  **Likely**, **Possible** or **Needs review**.
