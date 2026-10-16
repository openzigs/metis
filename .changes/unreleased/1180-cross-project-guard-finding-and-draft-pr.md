---
issue: 1180
section: Security
---

- Publishing a Deep Dive finding to GitHub, and opening a draft pull request, now ask for confirmation when the target repository is connected to another project, as batch publish does. The other project is named only if you can open it.
- The check ignores letter case, as GitHub does: a target typed `MiniFlux/V2` is recognised as the `miniflux/v2` another project connects. This also closes the gap for batch publish.
