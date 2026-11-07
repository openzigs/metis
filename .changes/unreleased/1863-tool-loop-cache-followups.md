---
issue: 1863
section: Fixed
---

- Chat's tool-loop prompt cache now applies only on Anthropic's own API or a proxy declared to relay
  to it. Requests to DeepSeek's Anthropic-format endpoint are again the ones sent before the tool-loop
  cache was added. When a chat turn runs out of tool calls, its final tool-free answer no longer
  re-writes the whole transcript to the cache at the write premium.
