---
name: go-methods-unresolved
description: The Go parser records methods as plain functions file::M, so h.store.M() calls stay unresolved (76% of calls in Miniflux).
metadata:
  type: project
---

The Go parser records `func (s *T) M()` as a plain `function` with qualified name `file::M`, so every `h.store.M()` call stays unresolved: 16.5k of 21.7k call edges in Miniflux. Anything walking resolved edges (impact blast radius, `search_code_graph` callers, the downstream schema walk) silently misses handler→storage paths in Go projects. #791 added an impact-only fallback (`server/src/lib/impact-analysis/go-call-resolution.ts`); the proper fix belongs in ingest (see #774).

**Why:** missing Go callers look like a weak model, not a parser gap.

**How to apply:** for Go call-graph gaps, check edge resolution first. Impact can be measured offline against `server/dev.db` with `computeProjectImpact`.
