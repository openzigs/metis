---
issue: 128
section: Security
---

- Project chats on tool-capable models can call METIS tools and tools from the project's MCP servers (`CHAT_TOOLS`, on by default).
- Every tool call now passes the session's approval policy and agent tool list; calls needing approval wait for Approve or Deny in the chat and are denied after `AI_TOOL_APPROVAL_TIMEOUT_MS`.
- Tool activity and each call's decision show in the chat; errors use fixed messages.
- Only a session's owner can answer its approvals (chat and MCP) or join its live-event room.
- Model and tool calls emit OpenTelemetry GenAI spans (usage, cache hits, time to first token), without prompt text unless `OTEL_GENAI_CAPTURE_CONTENT=true`.
- Analysis can use native tool calls with `ANALYSIS_NATIVE_TOOL_CALLS=true`; Anthropic tool loops keep extended-thinking blocks between turns.
