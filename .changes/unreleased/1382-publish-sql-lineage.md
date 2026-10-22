---
issue: 1382
section: Fixed
---

- Release tags publish `metis-sql-lineage` multi-arch, like the other three images.
  The Helm chart enables and pulls it by default, so a stock install of a tagged
  release left the sidecar in `ImagePullBackOff`. A test now fails when the chart
  names an image the release workflow does not publish.
