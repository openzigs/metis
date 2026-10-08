---
name: project_float-usd-to-cents
description: costUsd*100 vs integer cents picks up float error; round to cents before sign/zero decisions
metadata:
  type: project
---

Money arriving as float USD (`costUsd * 100`) and then compared with or subtracted from integer cents picks up floating-point error: `0.29*100 - 29 = -3.5e-15`, so a "remainder" displays as `-$0.0000` (PR #950 review). Reproduces with 0.29, 0.57, 0.58, 1.13.

**Why:** binary floats can't represent most decimal cents.

**How to apply:** round to whole cents (or to the display precision) before deciding a sign or testing for zero; test with 0.29/0.57/1.13.
