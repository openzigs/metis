---
issue: 1
section: Changed
---

- CI runs on GitHub-hosted runners. Every job previously named a self-hosted
  runner that does not exist in this repository, so no workflow could run at
  all. Standard hosted runners are free and uncapped on public repositories.
- The container image-size gate is back to its real budget. It allowed 1200 MB,
  which was an arm64 allowance for the old runner, not the documented amd64
  figure of 350 MB — a gate 3.4x looser than intended.
- The Windows regression guard runs again. It was disabled only because Windows
  minutes billed at 2x, which does not apply here.
