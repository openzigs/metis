#!/usr/bin/env bash
# #1379 — install a pinned, checksum-verified Trivy CLI into "$RUNNER_TEMP/trivy".
#
# Env: TRIVY_VERSION (e.g. 0.71.1) and TRIVY_SHA256 (of trivy_<v>_Linux-<TRIVY_ARCH>.tar.gz,
# from that release's trivy_<v>_checksums.txt). A mismatch fails before anything runs.
#
# Why the CLI rather than aquasecurity/trivy-action: see the comment on the step
# that calls this in .github/workflows/ci.yml. To move the version, take the new
# release's checksums file (`gh release download v<X> -R aquasecurity/trivy
# -p 'trivy_*_checksums.txt' -O -`) and update BOTH workflows that call this
# (ci.yml and build-images.yml) together.
set -euo pipefail

: "${TRIVY_VERSION:?TRIVY_VERSION must be set}"
: "${TRIVY_SHA256:?TRIVY_SHA256 must be set}"
dest="${RUNNER_TEMP:?RUNNER_TEMP must be set}/trivy"
# TRIVY_ARCH: the release asset suffix, `64bit` (amd64, the default) or `ARM64`.
tarball="trivy_${TRIVY_VERSION}_Linux-${TRIVY_ARCH:-64bit}.tar.gz"

mkdir -p "${dest}"
curl -fsSL --retry 3 -o "${dest}/${tarball}" \
  "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/${tarball}"
echo "${TRIVY_SHA256}  ${dest}/${tarball}" | sha256sum -c -
tar -xzf "${dest}/${tarball}" -C "${dest}" trivy
rm -f "${dest}/${tarball}"
"${dest}/trivy" --version
