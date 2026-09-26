/**
 * Epic #128 — run ONE model-requested tool call through the approval gate.
 *
 *   started → (awaiting_approval) → result | error
 *
 * The order is fixed and is the security property of this epic (#142): the
 * gate decides BEFORE `execute` is reached, on every path, and a denied,
 * expired or unanswerable call never executes. Arguments are validated first so
 * nobody is asked to approve a call that could not run.
 *
 * What comes back is recorded in full (the transcript keeps it); what the MODEL
 * reads is fenced as untrusted data; what a CLIENT sees is a bounded preview or
 * a fixed-vocabulary error (#143).
 */
import { audit } from "../../audit/audit-service.js";
import { createChildLogger } from "../../logger.js";
import { withExecuteToolSpan } from "../../otel/genai-spans.js";
import { scanForHiddenChars } from "../../mcp/hidden-char-scanner.js";
import { hashArgs, type ApprovalGateService } from "../approval-policy.js";
import type { ApprovalDecision } from "../types.js";
import type { RuntimeToolset } from "./toolset.js";
import {
  TOOL_ERROR_MESSAGES,
  preview,
  type RuntimeToolContext,
  type ToolErrorCode,
  type ToolEvent,
} from "./types.js";

const log = createChildLogger("tool-runtime");

export { TOOL_RESULT_FENCE, fenceToolResult } from "./fence.js";

export interface ToolCallRequest {
  /** The provider's call id (or a synthesised one on the text protocol). */
  id: string;
  /** The name the model used — a wire name or a canonical one. */
  name: string;
  args: unknown;
}

export interface ExecutedToolCall {
  callId: string;
  /** Canonical tool name when resolved, else the name the model used. */
  tool: string;
  args: unknown;
  /** Full result (or the server-authored reason it did not run). */
  text: string;
  isError: boolean;
  resultCount?: number;
  truncated?: boolean;
  /** Whether `execute` was reached. `false` for every refused call. */
  executed: boolean;
  decision?: ApprovalDecision;
  errorCode?: ToolErrorCode;
}

export interface ExecutorDeps {
  toolset: RuntimeToolset;
  gate: ApprovalGateService;
  ctx: RuntimeToolContext;
  onEvent?: (event: ToolEvent) => void;
  /**
   * Emits `awaiting_approval` for a prompt. Supplied by the caller that owns the
   * prompter (the gate's prompter calls {@link ExecutorDeps.onEvent} itself);
   * kept here so tests can drive the executor without a broker.
   */
  now?: () => number;
}

/** Model-facing text for a refused call — specific, but still server-authored. */
function refusalText(code: ToolErrorCode, reason?: string): string {
  switch (code) {
    case "TOOL_NOT_ALLOWED":
      return "Error: this tool is not allowed for this session's agent. Do not call it again.";
    case "TOOL_APPROVAL_EXPIRED":
      return "Error: the user did not approve this tool call in time, so it did not run.";
    case "TOOL_DENIED":
      return reason === "policy=deny"
        ? "Error: this session's approval policy does not allow this tool. Do not call it again."
        : "Error: the user denied this tool call, so it did not run. Do not retry it unless the user asks.";
    default:
      return `Error: ${TOOL_ERROR_MESSAGES[code]}`;
  }
}

export async function executeToolCall(
  call: ToolCallRequest,
  deps: ExecutorDeps,
): Promise<ExecutedToolCall> {
  const now = deps.now ?? (() => Date.now());
  const tool = deps.toolset.resolve(call.name);
  const argsJson = safeJson(call.args);
  const base: Omit<ToolEvent, "phase"> = {
    type: "tool_event",
    sessionId: deps.ctx.sessionId,
    callId: call.id,
    name: tool?.name ?? call.name,
    risk: tool?.risk ?? null,
    source: tool?.source ?? null,
    ts: now(),
  };
  const emit = (event: Partial<ToolEvent> & Pick<ToolEvent, "phase">): void => {
    if (!deps.onEvent) return;
    try {
      deps.onEvent({ ...base, ...event, ts: now() });
    } catch (err) {
      log.warn("Tool event listener threw; continuing", { error: (err as Error).message });
    }
  };
  const refuse = (
    code: ToolErrorCode,
    extra: { decision?: ApprovalDecision; reason?: string; modelText?: string } = {},
  ): ExecutedToolCall => {
    emit({ phase: "error", code, message: TOOL_ERROR_MESSAGES[code], isError: true });
    recordAudit(deps, call, tool?.name ?? call.name, code, extra.decision, false);
    return {
      callId: call.id,
      tool: tool?.name ?? call.name,
      args: call.args,
      text: extra.modelText ?? refusalText(code, extra.reason),
      isError: true,
      executed: false,
      ...(extra.decision ? { decision: extra.decision } : {}),
      errorCode: code,
    };
  };

  emit({
    phase: "started",
    argsPreview: preview(argsJson),
    ...(scanForHiddenChars(argsJson).length > 0 ? { argsHiddenChars: true } : {}),
  });

  if (!tool) {
    const available = deps.toolset.tools.map((t) => t.wireName).join(", ");
    return refuse("TOOL_UNKNOWN", {
      modelText: `Error: Unknown tool "${call.name}". Available tools: ${available}`,
    });
  }
  const valid = tool.validate(call.args);
  if (!valid.ok) {
    return refuse("TOOL_INVALID_ARGS", {
      modelText: `Error: the arguments for ${tool.wireName} do not match its parameter schema. Check the schema and call it again.`,
    });
  }

  // ── The gate. Nothing below runs unless it allowed THIS call. ──────────
  const decision = await deps.gate.evaluate({
    sessionId: deps.ctx.sessionId,
    userId: deps.ctx.userId,
    toolName: tool.name,
    risk: tool.risk,
    args: call.args,
    callId: call.id,
    ...(tool.forcePrompt ? { forcePrompt: true } : {}),
  });
  if (!decision.allowed) {
    const code: ToolErrorCode =
      decision.reason === "not_in_agent_allowlist"
        ? "TOOL_NOT_ALLOWED"
        : decision.decision === "expired"
          ? "TOOL_APPROVAL_EXPIRED"
          : "TOOL_DENIED";
    return refuse(code, { decision: decision.decision, reason: decision.reason });
  }

  try {
    const result = await withExecuteToolSpan(tool.source, tool.name, async (span) => {
      span.setAttribute("gen_ai.tool.call.id", call.id);
      span.setAttribute("metis.tool.risk", tool.risk);
      span.setAttribute("metis.tool.decision", decision.decision);
      const r = await tool.execute(valid.args, deps.ctx);
      span.setAttribute("metis.tool.is_error", r.isError === true);
      return r;
    });
    emit({
      phase: "result",
      resultPreview: preview(result.text),
      isError: result.isError === true,
    });
    recordAudit(deps, call, tool.name, result.isError ? "error" : "ok", decision.decision, true);
    return {
      callId: call.id,
      tool: tool.name,
      args: call.args,
      text: result.text,
      isError: result.isError === true,
      executed: true,
      decision: decision.decision,
      ...(typeof result.resultCount === "number" ? { resultCount: result.resultCount } : {}),
      ...(result.truncated ? { truncated: true } : {}),
    };
  } catch (err) {
    log.warn("Tool execution failed", {
      tool: tool.name,
      sessionId: deps.ctx.sessionId,
      error: (err as Error).message,
    });
    emit({ phase: "error", code: "TOOL_FAILED", message: TOOL_ERROR_MESSAGES.TOOL_FAILED });
    recordAudit(deps, call, tool.name, "TOOL_FAILED", decision.decision, true);
    return {
      callId: call.id,
      tool: tool.name,
      args: call.args,
      // #143 — this text is also the transcript's record, which the client
      // reads, so it is the fixed message too; the exception stays in the log.
      text: `Error: ${TOOL_ERROR_MESSAGES.TOOL_FAILED}`,
      isError: true,
      executed: true,
      decision: decision.decision,
      errorCode: "TOOL_FAILED",
    };
  }
}

/** #140 — every call is audited: actor, session, tool, args hash, outcome. */
function recordAudit(
  deps: ExecutorDeps,
  call: ToolCallRequest,
  toolName: string,
  outcome: string,
  decision: ApprovalDecision | undefined,
  executed: boolean,
): void {
  try {
    audit({
      actor: { id: deps.ctx.userId },
      action: "ai.tool.call",
      target: { type: "ai_session", id: deps.ctx.sessionId },
      metadata: {
        tool: toolName,
        callId: call.id,
        projectId: deps.ctx.projectId,
        argsHash: hashArgs(call.args),
        outcome,
        decision: decision ?? null,
        executed,
      },
    });
  } catch {
    /* audit is best-effort by contract */
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? "null";
  } catch {
    return String(value);
  }
}
