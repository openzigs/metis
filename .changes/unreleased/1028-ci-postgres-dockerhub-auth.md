---
issue: 1028
section: Changed
---

- CI signs in to Docker Hub for its Postgres jobs and image builds when the `DOCKERHUB_USERNAME`
  and `DOCKERHUB_TOKEN` secrets are set, and retries the Postgres image pull, so Docker Hub's
  anonymous pull limit no longer fails those jobs before any test runs.
