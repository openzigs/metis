/**
 * Epic #473 / Issue #474 — Agent tool interface definitions.
 *
 * Tools are callable by the agentic analysis loop. Each tool exposes a JSON
 * Schema for its parameters, a description for the LLM system prompt, and an
 * `execute` function that returns a stringified result.
 */
import type { CodeCitationRef } from "@metis/shared";
import type { CodeAccessFilter } from "./code-access.js";

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
  /**
   * #2243 — the files the caller may not see (document ACLs). Set by the chat
   * tool runtime for every code-tool call, and (#2314) by the analysis code
   * agent as a shared audience (`loadSharedCodeAccess`): its findings are read
   * by every project member, so never the requester's own access. Omitted (an
   * eval harness), nothing is hidden.
   */
  codeAccess?: CodeAccessFilter;
}

/**
 * #2390 — why a `resultCount: 0` result is not a miss (`search_code_graph`):
 *   - `ambiguous-name`: the name matched several symbols, listed as candidates;
 *   - `probable-call-sites`: no resolved caller, but call sites the parser could
 *     not resolve are listed;
 *   - `no-call-edges`: the symbol was found and the graph records no calls in
 *     the direction asked (any unresolved external calls are listed);
 *   - `filtered-out`: `calls`/`calledBy` found call edges, and a `query`,
 *     `kind` or `filePath` filter dropped every one (any probable call sites
 *     or unresolved calls are listed).
 */
export type ZeroResultKind =
  "ambiguous-name" | "probable-call-sites" | "no-call-edges" | "filtered-out";

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
  /**
   * #2390 — set ONLY with `resultCount: 0`, when that zero is not a miss: the
   * tool found what it was asked about and reports it in prose rather than as
   * results. Chat's search guidance gives these their own instruction instead
   * of "nothing was found; search again". Absent: a zero is a miss.
   */
  zeroResultKind?: ZeroResultKind;
  /**
   * #2324 — a fixed, server-authored instruction the model reads AFTER the
   * result's closing data fence (the chat runtime sets it on grounding tool
   * results). Never built from the result's text: what a tool retrieved stays
   * inside the fence.
   */
  instructions?: string;
  /**
   * #2325 — the citation contract: one ref per location the result returns,
   * with the indexed commit it describes. Chat records it with the call.
   */
  citations?: CodeCitationRef[];
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
