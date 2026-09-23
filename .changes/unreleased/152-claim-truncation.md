---
issue: 152
section: Fixed
---

- Grounding checks on large sections complete instead of being cut off. Claim
  extraction now splits a long section into passages of about 8,000 characters,
  so a 30,000-character formula-heavy section gets a complete claim list within
  an 8K output cap. A passage whose reply is still cut off is split and asked
  again.
- A grounding reply cut off at the output cap is no longer mistaken for one that
  ignored `json_schema`. It is not re-sent in `json_object` mode, which wasted
  several minutes per section, and the section's warning names the output cap
  to raise instead of telling you to set `json_object`.
- New setting `DOCS_GEN_CLAIM_MAX_OUTPUT_TOKENS` (default 16384) caps claim
  extraction on its own. It used to share the section cap.
- Indexing failures keep their specific wording again for a slow embedding
  host, a certificate problem, and a dropped connection. The approve/reject
  fallback uses the same wording.
- A provider that closes the connection before sending any response is now
  reported as that, not as a connection "dropped while the response was
  arriving".
