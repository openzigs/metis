---
issue: 1996
section: Fixed
---

- On a workspace's **Governing documents** page, a document's rule count and its open rules
  table now update as soon as its rule extraction finishes, instead of reading 0 rules and
  "No rules yet" until the page is reloaded. Retrying a failed extraction shows it running
  straight away, so a second click can no longer be refused as "still running". An
  extraction that has not finished after an hour (left behind by a server restart) now
  offers Retry extraction too, rather than sitting in pending or running for good.
- The upload dialogs' file pickers, for governing documents and project documents, now offer
  every accepted file type (`.md` and `.markdown` included), and the governing upload dialog
  lists the same types it accepts.
