---
issue: 724
section: Fixed
---

- Analysis spend now counts as project usage. The tokens used by an analysis run, a regenerated
  agent, a clarification round, a finding deep dive and a custom-agent playground run are recorded
  against the project. They now appear in Settings → Usage & cost and count toward the monthly
  token budget, and the Agent Runs view shows a cost for an analysis run. Before this fix all of
  them stayed at zero.
