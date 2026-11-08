---
issue: 1985
section: Fixed
---

- Governing documents: a policy's own control id is kept from more label lines above a
  clause: an id with a full stop (`4.3.1.`, `AC-02.`) and a numbered title (`4. Access`).
  A whole clause in bold, italics or quotes (`**AC-1 Accounts are never shared.**`) is no
  longer read as a label, so the clause under it does not take its id.
- Uploading a `.zip` folder connector over the 50 MB limit now answers `413 FILE_TOO_LARGE`
  ("The archive is larger than 50 MB") instead of a server error, and a cut-off upload body
  answers `400 UPLOAD_ERROR`, as the document uploads do.
- The upload size message now reads "The file is larger than 10 MB" instead of
  "File exceeds 10485760 byte limit".
- A refused governing rule-extraction retry now says "Too many rule-extraction retries"
  rather than "Too many uploads", and a burst of retries no longer uses up the upload limit.
- A page header's description holding a very long word wraps it inside the header instead of
  drawing it over the header's buttons.
