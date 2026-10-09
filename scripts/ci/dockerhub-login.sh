#!/usr/bin/env bash
# Signs the runner's Docker client in to Docker Hub when DOCKERHUB_USERNAME and
# DOCKERHUB_TOKEN are set (#1028), so image pulls are authenticated and not
# subject to Docker Hub's anonymous pull limit. Buildx reads the same
# credentials from ~/.docker/config.json, so it covers image builds too.
#
# It never fails the job: fork PRs see the secrets as empty, and a sign-in
# that still fails after its retries (auth endpoint timing out, expired or
# revoked token) leaves the client anonymous with a warning.
set -uo pipefail

if [ -z "${DOCKERHUB_USERNAME:-}" ] || [ -z "${DOCKERHUB_TOKEN:-}" ]; then
  echo "No Docker Hub credentials (fork PR or secrets unset); pulling anonymously."
  exit 0
fi

for attempt in 1 2 3; do
  if echo "${DOCKERHUB_TOKEN}" | docker login --username "${DOCKERHUB_USERNAME}" --password-stdin; then
    exit 0
  fi
  echo "::warning::docker login failed (attempt ${attempt}/3)"
  sleep $((attempt * 10))
done
echo "::warning::Docker Hub sign-in failed; pulling anonymously instead."
exit 0
