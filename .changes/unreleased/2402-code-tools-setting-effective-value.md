---
issue: 2402
section: Fixed
---

- Settings > Configuration no longer shows `CHAT_CODE_SEARCH_TOOLS` as on when code tools are off. Left unset, the setting is on for models with native tool calls and off for the rest, so the page now shows it as neither on nor off, with the note "on (native tool models only)". **Save** is disabled on an unset setting until you change it. Pressing Save on the untouched row used to store `true`, which quietly turned code tools on for models without native tool calls.
