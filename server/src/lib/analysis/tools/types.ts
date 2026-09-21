/**
 * Epic #473 / Issue #474 — Agent tool interface definitions.
 *
 * Tools are callable by the agentic analysis loop. Each tool exposes a JSON
 * Schema for its parameters, a description for the LLM system prompt, and an
 * `execute` function that returns a stringified result.
 */

export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema & { description?: string }>;
  required?: string[];
  items?: JSONSchema;
  enum?: string[];
  description?: string;
}

export interface ToolContext {
  projectId: string;
  connectorId?: string;
  cloneDir?: string;
}

export interface ToolResult {
  content: string;
  truncated?: boolean;
  /**
   * Issue #773 — the call FAILED (bad args, no code graph configured, an
   * exception). The agent loop forwards this onto the tool-call record, where it
   * feeds the retrieval-health gate: an error means RETRIEVAL IS BROKEN and says
   * nothing about the codebase.
   */
  isError?: boolean;
  /**
   * Issue #773 — how many results this call returned. `0` means a well-formed
   * EMPTY result: the tool worked and the thing is genuinely not there, which is
   * EVIDENCE OF ABSENCE (what a correct gap investigation returns), NOT evidence
   * that the run is degraded.
   *
   * Set it on every non-error return. Retrieval health used to infer this by
   * pattern-matching the tool's human-readable prose (`/^no\b/i`) — rewording a
   * no-results message would silently flip a verdict. This is the contract that
   * replaces the sniff; the sniff remains only as a fallback for legacy records.
   */
  resultCount?: number;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}

/**
 * Parsed tool-call request extracted from the LLM response.
 */
export interface ToolCallRequest {
  tool: string;
  args: Record<string, unknown>;
}
