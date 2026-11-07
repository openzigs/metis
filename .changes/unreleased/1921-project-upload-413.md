---
issue: 1921
section: Fixed
---

- Uploading a file over the 10 MB limit to a project's documents now answers
  `413 FILE_TOO_LARGE`, the same error the workspace governing-document upload
  gives, instead of a server error. A second file in the same upload is now a
  `400 UPLOAD_ERROR` rather than a server error. Both upload routes now read the
  file through one shared step.
