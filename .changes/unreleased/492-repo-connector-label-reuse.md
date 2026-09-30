---
issue: 492
section: Fixed
---

- Deleting a repository connector frees its label: re-adding the same
  repository under the same name no longer fails with "label already exists".
- Renaming a repository connector to a label another connector already uses is
  answered with that conflict (409) instead of an internal server error.
- Deleting an uploaded-archive connector removes the archive where it was
  actually stored, even if the archive directory setting has changed since, and
  removes its extraction directory too.
