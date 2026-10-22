---
issue: 1403
section: Fixed
---

- Generated documents quote a translated message as the text users see, not
  its translation key. When code shows a message by key
  (`error.bad_credentials`), the writer is given the text from the
  repository's own English locale file ("Invalid username or password."); a key
  with no text found is described, not quoted.
