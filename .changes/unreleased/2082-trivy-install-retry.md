---
issue: 2082
section: Fixed
---

- The image scan's Trivy install no longer fails the `api` job on a short burst of
  504s from GitHub's release downloads. It used to give up after about 7 seconds;
  it now retries for about a minute. A download that keeps failing still fails the
  job, and the SHA-256 check still runs on whatever is installed.
