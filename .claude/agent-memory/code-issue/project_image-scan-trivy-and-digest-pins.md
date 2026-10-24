---
name: image-scan-trivy-and-digest-pins
description: What the Trivy image scan does and does not see, and what pinning base images by digest costs (#1392).
metadata:
  type: project
---

**Why:** found patching, pinning and scanning the images in CI for #1377/#1379/#1382 (PR
#1392, 2026-10-21).

**How to apply:**

- **Trivy also reads SBOM files that packages ship** (`officeparser/dist/sbom.cdx.json`).
  A pnpm override can be right and the image still report the old version. Read the
  finding's `PkgIdentifier.BOMRef` before blaming the lockfile.
- **Trivy does not report CVEs in the Node.js or CPython runtime of the official
  `node`/`python` images** (measured on `node:22.1.0-alpine`, `python:3.12.0-slim`). Runtime
  fixes arrive only through base-image digest bumps.
- **Pinning by digest removes the automatic runtime security updates floating tags gave**
  (`apt`/`apk upgrade` do not touch `/usr/local`). Pair it with a Dependabot `docker`
  ecosystem (`.github/dependabot.yml`) and make sure `ci.yml` builds and scans
  `dependabot/docker/*` branches rather than skipping them.
- **dependabot-workspace-core rejects glob entries in `directories:`**; list each directory
  by name.
- **A `workflow_dispatch` of `ci.yml` on a PR branch uploads SARIF for that ref**, and
  GitHub then attaches a Trivy check to the PR head: an extra row in the check set.

**Red on every PR at once (2026-10-24).**
- The api job's Trivy scan (#1379) can turn every PR red between two runs when an upstream
  HIGH advisory is published. Before debugging a failing `api` with `api-outcome` also
  failing, check whether `main`'s latest `api` fails with the same `##[error]` lines (#1480).
- Trivy reports npm advisories by CVE alias, while the `sast.yml` OSV gate waives by GHSA.
  When a waived GHSA gains a CVE alias, the image scan goes red on `main`. Mirror it in
  `.github/image-scan-waivers.json` with `allowFixed` + `packages` (exact
  `name@installed`) + `mirrors` + `guards`, and retire both waivers together
  (`image-scan-waivers-mirror.test.mjs`, #1490).

Related: [[dependency-audit-flips-on-new-advisories]], [[helm-chart-install-and-networkpolicy-traps]].
