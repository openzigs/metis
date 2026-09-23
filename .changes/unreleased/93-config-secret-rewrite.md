---
issue: 93
section: Fixed
---

- Saving a secret in Settings no longer fails with a server error when that secret was cleared
  earlier, or when two saves of it arrive together. The write now replaces the stored value in a
  single step. Any database failure on this page is reported as a short fixed message, never as
  the database's own error text.
