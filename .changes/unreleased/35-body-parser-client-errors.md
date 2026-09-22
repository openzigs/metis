---
issue: 35
section: Fixed
---

- A request body over the size limit now returns 413 with error code
  `PAYLOAD_TOO_LARGE` instead of 500. The other request-body errors also
  return their own 4xx with a stable code: `UNSUPPORTED_CONTENT_ENCODING` and
  `UNSUPPORTED_CHARSET` (415), `TOO_MANY_PARAMETERS` (413), and
  `REQUEST_ABORTED`, `REQUEST_SIZE_MISMATCH` and `FORM_BODY_TOO_DEEP` (400).
  The parser's own message is not returned to the client.
