---
issue: 175
section: Fixed
---

- A Bedrock or Anthropic document whose section facts exceed the facts cap now
  carries a `facts-truncated` warning naming the section and how many modules
  were left out, as local documents already did. It names that provider's cap
  (`DOCS_GEN_BEDROCK_FACTS_CHAR_CAP` / `DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP`).
  Which modules are selected is unchanged.
