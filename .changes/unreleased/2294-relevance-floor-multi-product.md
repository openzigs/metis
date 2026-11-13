---
issue: 2294
section: Changed
---

- A chat over several projects now applies the same relevance floor as a one-project chat.
  A match too weak to bear on the question is left out in every project. When every match is
  too weak, the answer says the sources don't show this, and the label reads
  **Insufficient evidence**. The label also lists the files the excerpts came from, each named
  with its project.
- When the relevance floor leaves out a weak match, the next match that clears it takes the
  freed place, so the answer still gets up to 8 usable excerpts.
- When the floor leaves out every new match but excerpts from your last answer are carried
  over, the answer is told that this question's own search found nothing usable.
