---
issue: 2565
section: Added
---

- Operators can switch the analysis code pass to an explore-first mode with
  `ANALYSIS_CODE_EXPLORATION=explore`: it searches and reads whole files of the working tree
  before it answers, under the same turn and token limits as before. On a real product it found
  more of the files a change touches, at about 46% more cost and a few seconds more per
  requirement. The default stays `fast`, which is also the way to turn it off. A repository with
  no clone on the server always runs `fast`, and each analysis records which mode it ran in and
  why.
