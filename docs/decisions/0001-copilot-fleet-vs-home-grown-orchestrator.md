# ADR 0001 — Copilot Fleet vs home-grown orchestrator

- **Status:** Accepted
- **Date:** 2026-04-25
- **Resolves:** GitHub #118 (Phase 7 spike)
- **Related:** #54, #55, #165, #179, #180

## Context

The METIS platform runs a multi-agent analysis pipeline (Phase 7) consisting of
four parallel specialists (Business Analyst, Solution Architect, Domain / Data
Modeler, Risk / Compliance Researcher) followed by a synthesis step. Today this
runs on a custom orchestrator (`server/src/lib/analysis/orchestrator.ts`) that
fans out via `Promise.allSettled`, captures token usage per agent, and writes a
deterministic replay row.

GitHub Copilot ships **Copilot Fleet**, a native multi-agent orchestration
primitive that is part of the Copilot SDK. Fleet provides parallel subagent
fan-out, model routing per subagent, a typed handoff API, and built-in
observability hooks. Adopting Fleet would in principle replace much of the
home-grown orchestrator.

The decision must be made now (v1.1) before further investments in either
direction increase the cost of switching.

## Evaluation rubric

| Criterion              | Home-grown (current)                     | Copilot Fleet                        |
| ---------------------- | ---------------------------------------- | ------------------------------------ |
| Parallelism            | Native (`Promise.allSettled`)            | Native                               |
| Per-agent model        | Yes (`opts.model` per agent)             | Yes                                  |
| Handoff API            | Untyped object passed to synthesis       | Typed `HandoffContract`              |
| Observability          | OTel spans (#109), audit (#110), replay  | OTel hooks built in                  |
| Cost-per-turn          | ~5 calls (4 specialists + synthesis)     | ~2 calls (orchestrator + synthesis)  |
| Provider lock-in       | None — works for all providers           | **High — requires `@github/copilot`**|
| Image footprint        | 0 MB                                     | **~250 MB SDK deps**                 |
| Integration with #157  | Direct (Chronicle, ACLs, RAGAS)          | Requires re-wiring                   |
| Integration with #164  | Direct (SafetyHook, FinOps, autopilot)   | Requires re-wiring                   |
| Integration with #158  | Direct (OTel, replay, debug timeline)    | Requires re-wiring                   |

## Decision

**Stay on the home-grown orchestrator for v1.1.** Use the SDK shape
(`customAgents`, hook lifecycle, plan mode, `/model`, session resume) as a
**target interface** that the home-grown layer implements natively in METIS,
and that the future Copilot sidecar (#180) plugs into without changing METIS
internals.

## Rationale

1. **The Copilot SDK was dropped from the slim image (#179, follow-up #180).**
   `@github/copilot` and `@github/copilot-sdk` are no longer in
   `metis-server`'s `package.json`. Re-introducing them to land Fleet would
   regress the slim-image budget by ~250 MB and undo the work that already
   shipped in v1.1's MCP / observability / safety streams.
2. **The home-grown pipeline is already integrated with this session's other
   v1.1 features.** The SafetyHook chain (#100/#164), FinOps budget enforcer
   (#111/#164), OTel spans (#109), replay engine (#110), Chronicle (#157), and
   ACL / quarantine layer (#157) all sit inline in the orchestrator's hot
   path. Migrating to Fleet would require re-implementing every one of those
   integrations against Fleet's hook surface.
3. **Provider portability.** METIS supports `bedrock-gateway`, `openai`,
   `azure`, `anthropic`, `offline-stub`, and (future, via #180)
   `copilot-native`. A Fleet-only orchestrator would only work with the last
   one. Building the SDK abstractions (custom agents, hooks, plan mode) into
   METIS natively keeps every provider on equal footing.
4. **The cost-per-turn savings of Fleet (5 → 2 calls) do not materialise**
   when the synthesis step needs structured per-specialist outputs, which is
   what the requirements pipeline emits. Fleet's batched fan-out is optimised
   for stateless completions; ours is stateful per-agent persona work.
5. **Lock-in risk.** Fleet is a single-vendor primitive. The home-grown
   pipeline is portable; if we adopt Fleet now we couple the entire
   multi-agent architecture to Copilot's release cadence.

## Consequences

### Positive

- METIS can ship the SDK-shaped abstractions (`CustomAgent`,
  `HookSubscription`, `SessionPlan`, `/model` switching, session resume,
  plugin packaging) on top of the existing orchestrator without taking the
  slim-image regression.
- The future Copilot sidecar (#180) can implement the same shape and METIS
  code does not need to change to consume it.
- All providers continue to work. Custom hook subscriptions, plan-mode flow,
  and custom agents are provider-agnostic.

### Negative

- We carry the maintenance cost of the home-grown orchestrator for the
  foreseeable future.
- We do not benefit from Fleet's roadmap improvements (e.g., fan-in cost
  optimisations, native streaming handoff) without explicit re-evaluation.

### Follow-ups

- **#180** — when the Copilot sidecar lands, re-evaluate whether Fleet's
  primitives can be exposed as one of the orchestrator's pluggable execution
  modes (`mode: "fleet" | "native"`).
- The decision should be revisited at the **v1.2 planning checkpoint** once
  the sidecar is operational.

## Sources

- https://docs.github.com/en/copilot/concepts/agents/copilot-cli/fleet
- PR #179 — split embeddings into sidecar service to hit ≤350 MB image
- Issue #180 — Copilot CLI sidecar for native SDK execution
