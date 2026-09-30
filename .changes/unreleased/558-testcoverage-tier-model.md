---
issue: 558
section: Fixed
---

- The test-coverage judge and test-case suggestions no longer send a Claude Haiku model id to a
  provider that cannot serve it. On DeepSeek, OpenAI, Azure or a local runtime they now run the
  provider's configured model, and their response cache is keyed on that model, so a switch of
  provider never serves another model's cached verdicts or suggestions.
- A provider built from an explicit environment now reads its record/replay fixture directory
  (`AI_FIXTURE_DIR`) from that environment too, not from the server process's.
