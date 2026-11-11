---
issue: 2233
section: Fixed
---

- An analysis with more than 24 requirements no longer drops the rest without saying so. When the
  project has no code graph, evidence retrieval and the code check read only the first 24
  requirements, and the governing-rule check decides at most 24. The analysis page now shows a
  warning and an "Analysis limits" section that says, for each step, "Analyzed 24 of 41
  requirements" and names every requirement left out.
- An agent that writes more than 50 findings no longer loses the rest silently. The analysis page
  names the agent, how many findings it wrote and kept, and the title of each finding that was not
  saved.
- An analysis started from imported tracker items now gives the code agent each item's description
  and acceptance criteria, not only its title.
