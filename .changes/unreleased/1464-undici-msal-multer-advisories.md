---
issue: 1464
section: Security
---

- undici is upgraded past GHSA-xjj6-f33q-929c (a denial of service from excessive
  content-encodings): 8.12.2 in the API and 7.30.1 in the UI.
- @azure/msal-node 5.3.0 (Teams, via Bot Framework) is covered by a scoped waiver for
  GHSA-xcx6-jx8p-x3h5, expiring 2027-01-23: METIS never runs the MSAL
  authorization-code flow the advisory affects, and no parent accepts the fixed 7.x yet.
- multer 2.4.0 is covered by a scoped waiver for GHSA-q7qp-rjg7-q26m, expiring
  2026-10-30, until 2.5.0 clears the 7-day release-age hold. No METIS upload uses the
  asynchronous file filter the advisory needs.
