---
issue: 334
section: Security
---

- Opening a requirement baseline, or comparing two baselines, now checks that you can reach the
  baseline's project; a comparison checks both baselines. A baseline in another workspace's
  project answers "not found", the same as a baseline that does not exist.
- Acknowledging a finding for review now checks that you can reach the finding's project. A
  finding in another workspace's project answers "not found" and no acknowledgement is recorded.
- Reading a stored PR review now checks the run's project, and starting a PR review checks the
  project named in the request before the budget is read, so another project's spend is never
  disclosed. Both are admin-only permissions today; the check keeps them safe if that changes.
- Exporting a plugin now leaves out any custom agent or hook whose project you cannot reach,
  exactly as it leaves out an id that does not exist, so another workspace's agent prompts and
  hook settings can no longer be exported. Exporting hooks now needs the same permission as
  viewing them.
