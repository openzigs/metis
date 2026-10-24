---
issue: 1489
section: Security
---

- The container image scan gives the four npm advisories already waived by the
  dependency audit (msal-node, body-parser, multer, zod 3) matching waivers, with
  the same expiry dates and the same package copies, which restores a green `api`
  job.
- An image-scan waiver for a fixable finding must now name the exact
  `package@version` copies it covers. A different copy that can take the fix,
  such as a zod 4.x below 4.6.6, still fails the scan.
