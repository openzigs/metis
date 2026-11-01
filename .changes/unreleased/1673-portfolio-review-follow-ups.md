---
issue: 1673
section: Fixed
---

- A long portfolio check no longer turns into "you may not have access" partway
  through: the page stops re-reading a check that is gone, slows down when asked, and
  keeps the last answer on screen if a refresh fails.
- A product the change may reach only through a product you cannot read now reads
  **Restricted** in the impact list, the summary and the export, never "Not reached".
- The product picker searches all your products (it showed only the first 25), and
  the deep dive lists each shared resource under its own kind.
