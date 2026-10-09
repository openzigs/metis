---
issue: 1028
section: Changed
---

- CI's Postgres jobs sign in to Docker Hub when the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`
  secrets are set, and retry the image pull, so Docker Hub's anonymous pull limit no longer fails
  them before any test runs.
