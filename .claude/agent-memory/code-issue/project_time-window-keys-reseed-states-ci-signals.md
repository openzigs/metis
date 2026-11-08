---
name: time-window-keys-reseed-states-ci-signals
description: A cache key built from a now-relative window can revert to its pre-write value; a re-seed fix must be tested against every intermediate state earlier seeders left; plus two CI signals that misread (same-day image cache, CodeQL neutral).
metadata:
  type: project
---

**1. A cache key must never be built from a window measured back from now.** PR #1988 (#1944) first anchored the content-version window to `now − W` rather than to the latest write. Then a write from a replica whose clock runs behind (stamped below the max) moves the key only while that stamp is inside the reader's window. Once the stamp ages out, the key is byte-identical to the pre-write key, and pre-write cache entries are served again. The tool-result cache is on by default with a 30-minute TTL, so a stale entry can outlive an ACL edit or a soft delete. A test at a single instant cannot see this. The fix keeps `since = latestWrite − W` and skips the row read only when `now − latestWrite > 2W`.
**How to apply:** for any time-based cache key or content version, add a test that reads the key, writes below the max, moves the clock past the window, and asserts the key never equals the pre-write key.

**2. A "repair old rows on re-seed" fix must be tested against every state earlier seeders could leave, not only the oldest.** In #1987 (#1981), a pre-#1976 guessed row with a #1979-era file-level row beside it takes the existing-key `continue` before any repair logic runs. The unit fixture seeded only the oldest state, so it passed while the intermediate state stayed broken (follow-up #1989).

**3. Two CI signals that misread:**
- **Image scan.** The OS-upgrade layer was cached per day, so a Debian security fix published mid-day stayed unpatched, and Trivy failed on zlib CVEs that the code did not cause. Since #1957, `OS_PATCH_DATE` comes from `scripts/ci/os-patch-stamp.sh`, which stamps the date plus trixie-security InRelease `Date:`. Do not "fix" such a red with a CVE ignore.
- **CodeQL.** The `CodeQL` check can read **neutral**, "1 configuration not found … /language:python", while both `Analyze` jobs pass and the PR has 0 open alerts. That is an upload race, not a finding (#1980). Re-run the CodeQL workflow and re-read the check; do not count neutral as pass.
