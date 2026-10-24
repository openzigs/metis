---
name: custom-agent-usability-and-pre-gate-checks
description: Who may use a custom agent in a project, where a "can this still run" check goes (before the approval gate), and why that check must throw on a failed read rather than reuse an error-swallowing list helper (#1441 and its review).
metadata:
  type: project
---

From #1441 and its review (2026-10-23).

**The rule.** An explicit enablement row for (agent, project) decides; no row means owner only.
Use `customAgentUsableInProject` / `listUsableCustomAgentRows`
(`server/src/lib/agent-runtime/definition.ts`). ACP list-agents with a `projectId` uses
`listUsableCustomAgentRows`, the same rule as run-agent.

**Where the check goes.** `RuntimeTool.unavailableNow` (`lib/ai/tool-runtime/executor.ts`)
runs before the approval gate. Use it for any "can this still run?" check, or the call waits
out the 120 s approval timeout first.

**It must throw when its read fails.** A refuse-before-the-gate hook inherits its data
source's error handling. `safeCallable` (`tool-runtime/session-tools.ts`) returns `[]` on a
failed read, so an outage reads as "turned off". Use the throwing check (`isAgentCallable` /
`callableCheck`); list helpers that swallow errors are only for building offers. When
reviewing a new pre-gate check, trace whether its read can actually throw before trusting the
fallback.

Related: [[chat-tool-withholding-and-stream-retry]], [[secret-binding-fire-time-checks]].
