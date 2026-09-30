---
issue: 521
section: Fixed
---

- Defence in depth for streamed chat replies: an error raised on the reply's
  connection is now logged instead of going unhandled. The write-after-end
  crash itself was fixed in #506; this guards against any other error there.
