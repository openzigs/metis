---
issue: 1985
section: Fixed
---

- Governing documents keep a policy's control id from a label such as `4.3.1.` or `4. Access`,
  and a whole clause in bold or quotes no longer passes its id to the clause below.
- A `.zip` folder connector over 50 MB answers `413 FILE_TOO_LARGE`, not a server error, and
  the upload size message reads "The file is larger than 10 MB".
- A refused rule-extraction retry no longer reads "Too many uploads" or uses up the upload limit.
- A long word in a page header's description wraps instead of drawing over the header's buttons.
