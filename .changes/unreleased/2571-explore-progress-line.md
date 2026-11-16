---
issue: 2571
section: Added
---

- While METIS reads the code for a change request, its card and the change request header now say
  what it is doing in plain words, for example "Reading the code: 14 files read, 9 searches, 1 min
  10 s so far." The time counts up on the server's clock, so it is right even when this computer's
  clock is off. When the code is explored first, a second line explains that METIS is reading the
  code the way a developer would, which takes a little longer and finds more of what the change
  touches.
