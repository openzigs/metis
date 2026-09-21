/**
 * Epic #165 (#114) — Built-in hook handlers.
 *
 * Wires the existing cross-cutting concerns (audit log, OTel spans, FinOps
 * cost telemetry, MCP allowlist enforcement, safety) to the hook bus. The
 * implementation is observe-only: every handler writes its side effect and
 * returns `undefined`, leaving the payload untouched. Existing call-site
 * instrumentation continues to run in parallel — this keeps the migration
 * incremental and lets us fan-in to the bus without regressing behavior.
 *
 * Webhook-backed `HookSubscription` rows are dispatched here too: at session
 * start we read the project's enabled subscriptions and register a handler
 * per row that POSTs the payload to the configured URL.
 */
import { audit } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import { listEnabledFor, runWebhook } from "./subscriptions.js";
import { getHookBus, type HookBus } from "./bus.js";
import type {
  PostToolUsePayload,
  PreToolUsePayload,
  SessionEndPayload,
  SessionStartPayload,
  UserPromptSubmitPayload,
} from "./bus.js";

const log = createChildLogger("hooks-builtin");

let installed = false;

/**
 * Install global built-in handlers. Idempotent — calling twice is a no-op.
 * Should be invoked once from server bootstrap (`src/server.ts`).
 */
export function installBuiltinHandlers(bus: HookBus = getHookBus()): void {
  if (installed) return;
  installed = true;

  // sessionStart — audit + load this project's webhook subscriptions.
  bus.on(
    "sessionStart",
    async (p: SessionStartPayload) => {
      audit({
        actor: { id: p.userId },
        action: "session.start",
        target: { type: "ai_session", id: p.sessionId },
        metadata: { provider: p.provider, model: p.model, projectId: p.projectId },
      });
      if (p.projectId) {
        await registerProjectWebhooks(bus, p.projectId, p.sessionId);
      }
    },
    {},
    "builtin:session-start-audit",
  );

  // sessionEnd — close audit + tear down session-scoped registrations.
  bus.on(
    "sessionEnd",
    (p: SessionEndPayload) => {
      audit({
        actor: { id: p.userId },
        action: "session.end",
        target: { type: "ai_session", id: p.sessionId },
        metadata: { totalTokens: p.totalTokens, status: p.status },
      });
      bus.clearSession(p.sessionId);
    },
    {},
    "builtin:session-end-audit",
  );

  // userPromptSubmit — audit-log the prompt arrival. The inline safety chain
  // in CopilotWrapper still runs and is the authoritative deny gate; this
  // handler exists so user-defined webhooks can observe every prompt.
  bus.on(
    "userPromptSubmit",
    (p: UserPromptSubmitPayload) => {
      audit({
        actor: { id: p.userId },
        action: "user_prompt_submit",
        target: { type: "ai_session", id: p.sessionId },
        metadata: { projectId: p.projectId, length: p.prompt.length },
      });
    },
    {},
    "builtin:user-prompt-audit",
  );

  // preToolUse — log the call site so debug timeline picks it up.
  bus.on(
    "preToolUse",
    (p: PreToolUsePayload) => {
      audit({
        action: "tool.invoke.pre",
        target: { type: "ai_session", id: p.sessionId },
        metadata: { tool: p.toolName, projectId: p.projectId, riskLevel: p.riskLevel },
      });
    },
    {},
    "builtin:pretool-audit",
  );

  // postToolUse — record duration + token usage.
  bus.on(
    "postToolUse",
    (p: PostToolUsePayload) => {
      audit({
        action: "tool.invoke.post",
        target: { type: "ai_session", id: p.sessionId },
        metadata: {
          tool: p.toolName,
          projectId: p.projectId,
          durationMs: p.durationMs,
          promptTokens: p.promptTokens,
          completionTokens: p.completionTokens,
          errored: p.errored ?? false,
        },
      });
    },
    {},
    "builtin:posttool-audit",
  );

  // notification — surface to logs.
  bus.on(
    "notification",
    (p) => {
      const meta = { sessionId: p.sessionId, projectId: p.projectId, ...p.metadata };
      if (p.level === "error") log.error(p.message, meta);
      else if (p.level === "warn") log.warn(p.message, meta);
      else log.info(p.message, meta);
    },
    {},
    "builtin:notification",
  );
}

async function registerProjectWebhooks(
  bus: HookBus,
  projectId: string,
  sessionId: string,
): Promise<void> {
  for (const event of [
    "preToolUse",
    "postToolUse",
    "sessionStart",
    "sessionEnd",
    "userPromptSubmit",
    "notification",
  ] as const) {
    let subs;
    try {
      subs = await listEnabledFor(projectId, event);
    } catch (err) {
      log.warn("webhook subscription load failed", { event, error: (err as Error).message });
      continue;
    }
    for (const sub of subs) {
      if (sub.handlerKind !== "webhook") continue;
      const url = typeof sub.config.url === "string" ? sub.config.url : null;
      if (!url) continue;
      const headers = (sub.config.headers as Record<string, string> | undefined) ?? {};
      bus.on(
        event,
        async (payload) => {
          await runWebhook(url, { event, payload }, headers);
        },
        { projectId, sessionId },
        `webhook:${sub.id}`,
      );
    }
  }
}

/** Test helper. */
export function resetInstalledForTests(): void {
  installed = false;
}
