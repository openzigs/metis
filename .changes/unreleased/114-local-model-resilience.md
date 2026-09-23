---
issue: 114
section: Fixed
---

- A failed generation now names the real network cause: a slow model, a TLS
  certificate problem, or a connection dropped mid-response each get their own
  message; only a failed connect says "could not be reached". A local section
  whose connection drops mid-response is retried once with the same prompt.
- `DOCS_GEN_LOCAL_STRUCTURED_OUTPUT` takes `json_schema`, `json_object` or `off`
  (#117); an unparseable grounding reply marks the section "not fully verified"
  instead of passing unchecked.
- Document approve/reject 409s (#108) and a failed repo auto-ingest's progress
  event no longer carry raw error text.
