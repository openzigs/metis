---
name: preauth-limiters-keyed-on-req-ip
description: traceability-gaps and analysis-approval pre-auth limiters still key on client-writable req.ip; copy the runs signed-user-or-peer key (#838).
metadata:
  type: project
---

Not every rate limiter in `server/src/middleware/` is a safe template.

**Why:** under `trust proxy`, `req.ip` is the last `X-Forwarded-For` entry, which the client writes when the Next UI is the edge (see `spec-kit-job-rate-limit.ts`, #1105). `traceability-gaps-rate-limit.ts` (`traceabilityPreAuthRateLimiter`) and `analysis-approval-rate-limit.ts` (`analysisApprovalPreAuthRateLimiter`) still key their pre-auth limiter on `req.ip`. #838 pointed at the former as the pattern to copy.

**How to apply:**

- For a new pre-auth limiter, use the signed-token-user-or-TCP-peer key from `runs-rate-limit.ts` (shared since #1348), never `req.ip`.
- The two `req.ip` limiters above are candidates for the same fix.
