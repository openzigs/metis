---
issue: 1460
section: Security
---

- body-parser is upgraded to 2.4.0 (GHSA-27r3-jxmh-p828) and multer to 2.5.0
  (GHSA-q7qp-rjg7-q26m), and the temporary waivers for both advisories are removed.
  Compressed request bodies are still refused with 415, as no METIS client sends one.
