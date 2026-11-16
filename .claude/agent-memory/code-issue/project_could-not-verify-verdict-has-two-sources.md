---
name: could-not-verify-verdict-has-two-sources
description: A finding's persisted could-not-verify verdict comes from the model or from gateFindingVerdict downgrading an implemented claim; the evidence blob does not say which.
metadata:
  type: project
---

A finding's persisted `could-not-verify` verdict has two sources: the model wrote it, or `gateFindingVerdict` downgraded an `implemented` claim that had grounded code (unhealthy retrieval, the #826 schema gate). The stored evidence blob does not record which one (#2513 review).

**Why:** a fix or a metric that reads `could-not-verify` as "the model was unsure" miscounts every gate downgrade, and the two have different remedies (prompt vs retrieval health).

**How to apply:** before changing behaviour or reporting on `could-not-verify` findings, decide whether the gate's downgrades belong in the set. If the distinction matters, record the source at the gate rather than inferring it later from the blob.
