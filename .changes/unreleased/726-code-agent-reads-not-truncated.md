---
issue: 726
section: Fixed
---

- The code agent writes its findings over the full text of the files it read.
  Earlier reads had been shortened to their first lines to save tokens, so a
  short function it had read in full looked "truncated after its header".
- Shortening now drops old search results before file reads, and a file read of
  exactly the lines requested is no longer flagged as truncated.
- A "Could not verify" finding no longer shows a green "Confirmed" badge.
