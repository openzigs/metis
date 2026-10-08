---
issue: 948
section: Added
---

- The end-to-end walkthrough's test plan now lives in
  `docs/walkthroughs/TEST_PLAN.md` instead of issue #706's body, corrected for
  the routes and pages run 4 found dead and the steps added since.
- A PR that adds or removes a UI page or a server route must update the plan or
  carry the `no-walkthrough-impact` label; CI checks it.
- `pnpm walkthrough:check-plan` fails when the plan names an API route or page
  that no longer exists. CI runs it on every PR.
