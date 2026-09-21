/**
 * Epic #165 (#114) — SDK lifecycle hook bus.
 *
 * Provides a typed, async event bus matching the Copilot SDK's hook surface
 * (`preToolUse`, `postToolUse`, `sessionStart`, `sessionEnd`, `userPromptSubmit`,
 * `notification`). The Copilot SDK was dropped from `metis-server` in #179, so
 * this bus is implemented natively in METIS and works for every provider
 * (`bedrock-gateway`, `openai`, `azure`, `anthropic`, `offline-stub`, plus the
 * future `copilot-native` once #180 lands).
 *
 * Handlers are registered globally (from server bootstrap) or per-session (via
 * `HookSubscription` rows). Built-in handlers wire the existing cross-cutting
 * concerns (audit, OTel, FinOps, MCP approval, safety) into the bus surface
 * instead of scattering them through every call site.
 *
 * Determinism: handlers run sequentially in registration order. A handler that
 * throws is caught — its error is logged via the supplied logger callback and
 * does NOT abort the chain (we never want a misbehaving webhook to break a
 * session). Handlers that need to mutate the payload should return the next
 * payload value; handlers that observe-only return `undefined`.
 */

import { SDK_HOOK_EVENTS, type SdkHookEvent } from "@metis/shared";

export type { SdkHookEvent };

export interface PreToolUsePayload {
  sessionId: string;
  projectId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  riskLevel?: "low" | "medium" | "high";
}

export interface PostToolUsePayload {
  sessionId: string;
  projectId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  errored?: boolean;
}

export interface SessionStartPayload {
  sessionId: string;
  projectId: string | null;
  userId: string;
  provider: string;
  model: string;
}

export interface SessionEndPayload {
  sessionId: string;
  projectId: string | null;
  userId: string;
  totalTokens: number;
  status: string;
}

export interface UserPromptSubmitPayload {
  sessionId: string;
  projectId: string | null;
  userId: string;
  prompt: string;
}

export interface NotificationPayload {
  sessionId: string | null;
  projectId: string | null;
  level: "info" | "warn" | "error";
  message: string;
  metadata?: Record<string, unknown>;
}

export interface HookEventMap {
  preToolUse: PreToolUsePayload;
  postToolUse: PostToolUsePayload;
  sessionStart: SessionStartPayload;
  sessionEnd: SessionEndPayload;
  userPromptSubmit: UserPromptSubmitPayload;
  notification: NotificationPayload;
}

export type HookHandler<E extends SdkHookEvent> = (
  payload: HookEventMap[E],
) => Promise<HookEventMap[E] | void> | HookEventMap[E] | void;

interface Registration<E extends SdkHookEvent = SdkHookEvent> {
  event: E;
  handler: HookHandler<E>;
  scope: { projectId?: string | null; sessionId?: string | null };
  /** Free-form name for diagnostics. */
  name?: string;
}

export interface HookBusOptions {
  onError?: (event: SdkHookEvent, name: string | undefined, err: unknown) => void;
}

export class HookBus {
  private readonly registrations: Registration[] = [];
  private readonly opts: Required<HookBusOptions>;

  constructor(opts: HookBusOptions = {}) {
    this.opts = {
      onError:
        opts.onError ??
        ((event, name) => {
          // Default: emit to stderr so a buggy hook is visible without
          // requiring the logger module (which itself subscribes to hooks).
          process.stderr.write(`[hooks] ${event} handler ${name ?? "anonymous"} threw\n`);
        }),
    };
  }

  on<E extends SdkHookEvent>(
    event: E,
    handler: HookHandler<E>,
    scope: Registration["scope"] = {},
    name?: string,
  ): () => void {
    const reg = { event, handler, scope, name } as unknown as Registration;
    this.registrations.push(reg);
    return () => this.off(reg);
  }

  off(reg: Registration): void {
    const i = this.registrations.indexOf(reg);
    if (i >= 0) this.registrations.splice(i, 1);
  }

  /** Remove every registration scoped to the given session. */
  clearSession(sessionId: string): void {
    for (let i = this.registrations.length - 1; i >= 0; i--) {
      if (this.registrations[i]!.scope.sessionId === sessionId) {
        this.registrations.splice(i, 1);
      }
    }
  }

  /**
   * Fire `event` against every matching handler in registration order. The
   * payload is threaded through each handler — a handler may return a new
   * value to mutate the payload for downstream handlers / the original
   * call site. Returns the final (possibly mutated) payload.
   */
  async emit<E extends SdkHookEvent>(event: E, initial: HookEventMap[E]): Promise<HookEventMap[E]> {
    let payload = initial;
    for (const reg of this.registrations) {
      if (reg.event !== event) continue;
      if (!matchesScope(reg.scope, payload)) continue;
      try {
        const r = await (reg.handler as unknown as HookHandler<E>)(payload);
        if (r != null) payload = r;
      } catch (err) {
        this.opts.onError(event, reg.name, err);
      }
    }
    return payload;
  }

  /** For tests — number of registered handlers (optionally per-event). */
  count(event?: SdkHookEvent): number {
    if (!event) return this.registrations.length;
    return this.registrations.filter((r) => r.event === event).length;
  }
}

function matchesScope(scope: Registration["scope"], payload: unknown): boolean {
  if (!scope.projectId && !scope.sessionId) return true;
  const p = payload as { projectId?: string | null; sessionId?: string | null };
  if (scope.projectId != null && p.projectId !== scope.projectId) return false;
  if (scope.sessionId != null && p.sessionId !== scope.sessionId) return false;
  return true;
}

let singleton: HookBus | null = null;
export function getHookBus(): HookBus {
  if (!singleton) singleton = new HookBus();
  return singleton;
}

/** Test helper. */
export function setHookBusForTests(bus: HookBus | null): void {
  singleton = bus;
}

export const ALL_HOOK_EVENTS: readonly SdkHookEvent[] = SDK_HOOK_EVENTS;
