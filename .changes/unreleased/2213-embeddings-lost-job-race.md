---
issue: 2213
section: Fixed
---

- **Settings → Embedding backends** no longer keeps re-reading coverage every 15 seconds after
  the reindex it was following died with its server, and a reindex started later is followed
  under its own job rather than the dead one.
- Clicking **Reindex** while a coverage read was in flight no longer re-enables the button for
  up to 15 seconds (where a second click was refused as already in progress): a read sent before
  the reindex started no longer counts as proof that it died.
