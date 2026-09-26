/**
 * Tool registry (Phase 4 / issue #34).
 *
 * Each tool registers a zod schema, a risk classification, and an `exec`
 * handler. Calling `invoke` validates the args, then routes through the
 * approval policy before running the handler. Anything that bypasses
 * `invoke` (direct property access) is intentionally NOT supported — risk
 * gating is the whole point of the abstraction.
 */
import { z } from "zod";
import { AIToolDeniedError, AIToolInvalidArgsError, AIError } from "./errors.js";
import type { RiskLevel, ToolContext, ToolDefinition, ToolOrigin, ToolResult } from "./types.js";
import { toolParametersSchema } from "./tool-runtime/json-schema.js";

/** Public, exec-free view of a registered tool. */
export interface ToolDescriptor {
  name: string;
  description: string;
  risk: RiskLevel;
}

const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high"];

const isRisk = (value: unknown): value is RiskLevel =>
  typeof value === "string" && (RISK_LEVELS as readonly string[]).includes(value);

export interface ApprovalGate {
  /**
   * Called once per invocation. Implementations resolve to `true` to allow
   * the call, `false` to deny. Throwing aborts the invocation with whatever
   * error the gate raised.
   */
  decide(input: {
    sessionId: string;
    userId: string;
    toolName: string;
    risk: RiskLevel;
    args: unknown;
  }): Promise<boolean>;
}

/**
 * #142 — what the tool runtime needs to OFFER a tool: its metadata and the JSON
 * Schema of its arguments. Like {@link ToolDescriptor} it never exposes `exec`.
 */
export interface ToolRuntimeView extends ToolDescriptor {
  parameters: Record<string, unknown>;
  origin?: ToolOrigin;
}

export class ToolRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly tools = new Map<string, ToolDefinition<any>>();

  /** Register a tool. Throws when the risk classification is missing/invalid. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(tool: ToolDefinition<any>): void {
    if (!tool.name || typeof tool.name !== "string") {
      throw new TypeError("tool.name is required");
    }
    if (!isRisk(tool.risk)) {
      throw new TypeError(
        `tool ${tool.name} requires a valid risk classification (low|medium|high)`,
      );
    }
    if (!(tool.schema instanceof z.ZodType)) {
      throw new TypeError(`tool ${tool.name} requires a zod schema`);
    }
    if (typeof tool.exec !== "function") {
      throw new TypeError(`tool ${tool.name} requires an exec function`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`tool ${tool.name} is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Return a metadata-only descriptor for a tool. The live `exec` function is
   * intentionally NOT exposed — callers MUST go through {@link invoke} so that
   * zod validation and the approval gate run. (Returning `exec` would let a
   * caller invoke a high-risk tool without ever touching the gate.)
   */
  get(name: string): ToolDescriptor | undefined {
    const t = this.tools.get(name);
    if (!t) return undefined;
    return { name: t.name, description: t.description, risk: t.risk };
  }

  /** #142 — the runtime view of one tool (no `exec`), or `undefined`. */
  describe(name: string): ToolRuntimeView | undefined {
    const t = this.tools.get(name);
    if (!t) return undefined;
    return {
      name: t.name,
      description: t.description,
      risk: t.risk,
      parameters: t.parameters ?? toolParametersSchema(t.schema as z.ZodTypeAny),
      ...(t.origin ? { origin: t.origin } : {}),
    };
  }

  /** #142 — every tool's runtime view, in registration order. */
  describeAll(): ToolRuntimeView[] {
    return [...this.tools.keys()].map((n) => this.describe(n)!);
  }

  /**
   * #142 — do these raw arguments satisfy the tool's schema? Lets the runtime
   * reject a malformed call BEFORE a person is asked to approve it.
   */
  validate(name: string, rawArgs: unknown): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;
    return (tool.schema as z.ZodTypeAny).safeParse(rawArgs).success;
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      risk: t.risk,
    }));
  }

  /**
   * Validate args, run the approval gate, then execute the tool.
   *
   * Errors raised by the gate or the handler are wrapped in `AIError`
   * subclasses so route handlers can pattern-match on `code`.
   *
   * #142 — the gate is REQUIRED. It used to default to allow-all, so any caller
   * that forgot it ran a high-risk tool with no approval at all; a missing gate
   * now fails closed.
   */
  async invoke(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
    gate: ApprovalGate,
  ): Promise<ToolResult> {
    if (!gate || typeof gate.decide !== "function") {
      throw new AIToolDeniedError(`tool ${name} was invoked without an approval gate`, {
        tool: name,
      });
    }
    const tool = this.tools.get(name);
    if (!tool) {
      throw new AIError("AI_TOOL_NOT_FOUND", `tool ${name} is not registered`, 404);
    }

    let args: unknown;
    try {
      args = (tool.schema as z.ZodTypeAny).parse(rawArgs);
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new AIToolInvalidArgsError(`invalid arguments for tool ${name}`, err.flatten());
      }
      throw err;
    }

    const allowed = await gate.decide({
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      toolName: name,
      risk: tool.risk,
      args,
    });
    if (!allowed) {
      throw new AIToolDeniedError(`tool ${name} (${tool.risk} risk) was denied`, {
        tool: name,
        risk: tool.risk,
      });
    }

    try {
      return await tool.exec(args, ctx);
    } catch (err) {
      if (err instanceof AIError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return { text: `[Tool Error] ${message}`, isError: true };
    }
  }
}

let singleton: ToolRegistry | null = null;
export function getToolRegistry(): ToolRegistry {
  if (!singleton) singleton = new ToolRegistry();
  return singleton;
}

/** Test helper. */
export function __resetToolRegistrySingleton(): void {
  singleton = null;
}
