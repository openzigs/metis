---
issue: 189
section: Fixed
---

- Generating a document no longer freezes the server. The search embedding that
  runs after generation now happens in a background worker thread, not on the
  server's main thread. While a 611,592-character document was embedded, `/healthz`
  answered in at most 139 ms. The same work previously held one request for 5.2
  minutes.
- Generated documents no longer stay "processing" forever. Each input to the model
  is now capped at 1,500 characters and 2,048 tokens. Documents already stuck are
  repaired when the server starts.
