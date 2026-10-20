---
issue: 1278
section: Fixed
---

- On Claude Opus 5.5, Fable and Mythos, which cannot switch reasoning off,
  generated documents reserve extra output room for that reasoning, so it no
  longer cuts a section short. Other Claude models are sent what they were before.
