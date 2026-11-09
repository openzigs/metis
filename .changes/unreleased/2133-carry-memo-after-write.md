---
issue: 2133
section: Fixed
---

- If saving an answer carried over to another requirement fails, METIS now tries that carry
  again the next time the same answer is retried. Before, it treated the carry as done, and
  you could be asked a question your answer already settled.
