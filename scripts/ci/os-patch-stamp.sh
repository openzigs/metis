#!/usr/bin/env bash
# The OS_PATCH_DATE build arg: the cache key of every runtime stage's
# `apt-get upgrade` / `apk upgrade` layer (#1379).
#
# Today's date alone busts that layer once a day, so a Debian security fix
# published after the day's first build stayed behind the cached layer until the
# next day: zlib1g's deb13u1 (CVE-2026-76844, CVE-2026-85091) landed in
# trixie-security at 15:52 UTC on 2026-11-07 and every later build that day kept
# the vulnerable +b1, failing the image scan. The stamp therefore adds the
# `Date:` of trixie-security's InRelease, which changes exactly when Debian
# publishes a security update, so the layer is rebuilt then and only then.
#
# Alpine's index (the UI image) is not read: it stays on the daily bust.
# If the index cannot be fetched, the stamp is the date alone: the old behaviour.
set -euo pipefail
day="$(date -u +%F)"
index="$(curl -fsS --max-time 15 --retry 2 \
  http://deb.debian.org/debian-security/dists/trixie-security/InRelease 2>/dev/null \
  | sed -n 's/^Date: //p' | head -n 1 || true)"
if [ -n "$index" ] && epoch="$(date -u -d "$index" +%s 2>/dev/null)"; then
  echo "${day}.deb-security-${epoch}"
else
  echo "$day"
fi
