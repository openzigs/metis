#!/usr/bin/env bash
# Starts the pgvector Postgres container that the postgres-* CI jobs test
# against, binds it to an ephemeral host port and exports DATABASE_URL.
#
# It replaces the jobs' `services:` block. A service container's image is
# pulled by the runner before any step runs, anonymously unless the job
# declares credentials, and a fork PR sees every secret as empty. Docker Hub's
# anonymous pull limit (and its auth endpoint timing out) failed these jobs
# before a single test ran. Here the pull signs in only when
# DOCKERHUB_USERNAME and DOCKERHUB_TOKEN are set, falls back to an anonymous
# pull otherwise, and retries with backoff either way.
set -euo pipefail

IMAGE="${PG_IMAGE:-pgvector/pgvector:pg16}"
NAME="${PG_CONTAINER_NAME:-metis-ci-postgres-${GITHUB_JOB:-local}-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-1}}"
# Both postgres jobs can share one runner and Docker daemon (#754), so the
# name is per job and run; the job's final step removes the container.
docker rm -f "${NAME}" >/dev/null 2>&1 || true

bash "$(dirname "$0")/dockerhub-login.sh"

pulled=0
for attempt in 1 2 3 4 5; do
  if docker pull "${IMAGE}"; then
    pulled=1
    break
  fi
  delay=$((attempt * 15))
  echo "::warning::docker pull ${IMAGE} failed (attempt ${attempt}/5); retrying in ${delay}s"
  sleep "${delay}"
done
if [ "${pulled}" -ne 1 ]; then
  echo "::error::could not pull ${IMAGE} after 5 attempts"
  exit 1
fi

# #754: an EPHEMERAL host port. Both postgres jobs can share one runner and
# its port space, and a fixed 5432 made the second container fail to bind.
docker run -d --name "${NAME}" \
  -e POSTGRES_USER=metis -e POSTGRES_PASSWORD=metis -e POSTGRES_DB=metis \
  -p 127.0.0.1::5432 \
  --health-cmd "pg_isready -U metis" --health-interval 5s \
  --health-timeout 5s --health-retries 10 \
  "${IMAGE}" >/dev/null

for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "${NAME}")"
  [ "${status}" = "healthy" ] && break
  sleep 2
done
if [ "${status}" != "healthy" ]; then
  echo "::error::postgres container did not become healthy (status: ${status})"
  docker logs "${NAME}" | tail -50
  exit 1
fi

port="$(docker port "${NAME}" 5432/tcp | head -1 | sed 's/.*://')"
if [ -z "${port}" ]; then
  echo "::error::postgres container exposed no host port for 5432"
  exit 1
fi
# 127.0.0.1, not localhost: the port is bound to IPv4 loopback only, and
# localhost can resolve to ::1 first.
echo "DATABASE_URL=postgresql://metis:metis@127.0.0.1:${port}/metis" >> "${GITHUB_ENV:-/dev/stdout}"
echo "Postgres (${IMAGE}) is healthy on host port ${port}"
