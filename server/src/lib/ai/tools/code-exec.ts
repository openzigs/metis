/**
 * Epic #192 (A.2) — `code_exec` tool registration.
 *
 * Wraps {@link SandboxClient} as a HIGH-risk registered AI tool so agents can
 * invoke sandbox execution through the standard {@link ToolRegistry.invoke}
 * pipeline (zod validation + risk gate + audit). Only registered when
 * `SANDBOX_MODE=sidecar` — when the mode is unset the tool is unavailable
 * and any invocation attempt results in `AI_TOOL_NOT_FOUND` from the registry.
 *
 * Cost telemetry: every successful exec records to the FinOps token tracker
 * with `provider: "openai"` and a `e2b:` model prefix so dashboards can
 * filter sandbox spend without expanding the cost-cap union (mirrors the
 * `morph:` prefix used by `apply_diff`). The full sandbox accounting is
 * also surfaced on the response payload (`provider: "e2b"`, durationMs,
 * truncated, exitCode) so per-run rollups can attribute usage accurately.
 */
import { z } from "zod";
import {
  SandboxClient,
  SandboxClientError,
  isSandboxSidecarMode,
} from "../../sandbox/sandbox-client.js";
import { getTokenTracker } from "../token-tracker.js";
import type { ToolDefinition, ToolResult, ToolContext } from "../types.js";

export const CODE_EXEC_TOOL_NAME = "code_exec";

export const codeExecSchema = z.object({
  language: z.enum(["python", "node", "bash"]),
  code: z
    .string()
    .min(1)
    .max(64 * 1024),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});

export type CodeExecArgs = z.infer<typeof codeExecSchema>;

export interface CodeExecDeps {
  client?: SandboxClient;
  /** Test seam — override the SANDBOX_MODE gate. */
  isEnabled?: () => boolean;
}

export function createCodeExecTool(deps: CodeExecDeps = {}): ToolDefinition<typeof codeExecSchema> {
  return {
    name: CODE_EXEC_TOOL_NAME,
    description:
      "Execute code (python|node|bash) inside an isolated E2B microVM and return stdout/stderr/exitCode. HIGH risk — every call is gated by the approval policy unless Project.autoApproveSandbox is set.",
    schema: codeExecSchema,
    risk: "high",
    async exec(args: CodeExecArgs, ctx: ToolContext): Promise<ToolResult> {
      const start = Date.now();
      const client = deps.client ?? new SandboxClient();
      try {
        const out = await client.exec(args);
        // FinOps tag — sandbox execs aren't token-priced but we still want
        // them to land in /usage as a `e2b:` event so finance can see the
        // call counts. Non-zero `totalTokens` is required to persist, so
        // record 1/1 as a sentinel "1 sandbox exec" unit.
        try {
          getTokenTracker().record({
            sessionId: ctx.sessionId,
            userId: ctx.userId,
            provider: "openai",
            model: `e2b:${args.language}`,
            usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
          });
        } catch (err) {
          ctx.log?.error("code_exec failed to record FinOps usage", {
            error: (err as Error).message,
          });
        }
        const summary = `exit ${out.exitCode} in ${out.durationMs}ms\n--- stdout ---\n${out.stdout}\n--- stderr ---\n${out.stderr}`;
        return {
          text: summary,
          data: {
            ...out,
            provider: "e2b",
            language: args.language,
            durationMs: out.durationMs,
          },
          isError: out.exitCode !== 0,
        };
      } catch (err) {
        const message =
          err instanceof SandboxClientError
            ? `${err.code}: ${err.message}`
            : (err as Error).message;
        ctx.log?.error("code_exec sandbox call failed", {
          error: message,
          status: err instanceof SandboxClientError ? err.status : null,
        });
        return {
          text: `sandbox failed: ${message}`,
          data: {
            provider: "e2b",
            error: message,
            status: err instanceof SandboxClientError ? err.status : 502,
            durationMs: Date.now() - start,
          },
          isError: true,
        };
      }
    },
  };
}

export interface RegisterCodeExecResult {
  registered: boolean;
  reason?: string;
}

/**
 * Register `code_exec` against a tool registry — but only when the sidecar
 * sandbox mode is active. Returns `{ registered: false, reason: ... }` so
 * callers (boot scripts) can log why the tool is unavailable.
 */
export function registerCodeExec(
  registry: {
    register: (t: ToolDefinition) => void;
    unregister: (n: string) => boolean;
    has: (n: string) => boolean;
  },
  deps: CodeExecDeps = {},
): RegisterCodeExecResult {
  const isEnabled = deps.isEnabled ?? isSandboxSidecarMode;
  if (!isEnabled()) {
    // Make sure no stale registration lingers.
    registry.unregister(CODE_EXEC_TOOL_NAME);
    return { registered: false, reason: "SANDBOX_MODE is not set to sidecar" };
  }
  registry.unregister(CODE_EXEC_TOOL_NAME);
  registry.register(createCodeExecTool(deps) as unknown as ToolDefinition);
  return { registered: true };
}
