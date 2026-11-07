---
issue: 1956
section: Security
---

- Container images now pick up a Debian security fix the same day it is published, not
  the next day: the cached `apt-get upgrade` layer is rebuilt whenever Debian's security
  index changes, as well as daily. This brings in the fixed zlib for CVE-2026-76844 and
  CVE-2026-85091.
