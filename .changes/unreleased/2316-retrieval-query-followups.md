---
issue: 2316
section: Fixed
---

- A chat follow-up no longer loses excerpts your own words found. The 8 best excerpts for your
  message are always kept, and the earlier question adds at most 3 more. Before, those could
  push out one of your own 8, which is how "How often does that run?" lost the scheduler file it
  asked about.
- The excerpts an answer cited are read more exactly on the next turn. "`internal/ui/oauth.go`
  (chunk #3)" no longer counts as citing chunk 3 of a different file named `auth.go`, and
  "chunk #5 - 2 places" no longer counts as citing chunk 2.
