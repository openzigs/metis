---
name: grounding-from-auto-rag-misses-tools
description: Chat grounding built from RagContextCapture.contexts misses what tools retrieved; never label a reply "general knowledge" from auto-RAG alone.
metadata:
  type: project
---

PR #437 (#18) computed each reply's grounding from `ragCapture.contexts`, which auto-RAG fills before any tool runs. A scoped session also offers code-search, tree and MCP tools, so a reply labelled `no-context` ("answered from the model's general knowledge") could have read the project through those tools. The label was false on screen. It now says only "No excerpts from X were retrieved automatically" (tool counting is tracked in #439).

**Why:** auto-RAG and tool retrieval are separate channels, and the capture object only sees the first.

**How to apply:** any provenance, citation or grounding claim about a chat turn must either include tool results or be worded as "auto-retrieval supplied …", never as a claim about what the answer rests on.
