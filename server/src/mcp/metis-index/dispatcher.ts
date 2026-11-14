/**
 * #2331 — one `metis_*` tool call, end to end.
 *
 *   1. resolve the credential to ONE METIS user (`identity.ts`), or refuse;
 *   2. a project-scoped tool: the user must be able to read the project
 *      (`assertLiveProjectAccess`, the rule every project route uses); a
 *      project they cannot read answers exactly as one that does not exist;
 *   3. load the user's per-document ACL filter in that project
 *      (`loadCodeAccessFilter`, `code-access.ts`) — the filter chat's code
 *      tools run with, so a file restricted from them is neither read, listed
 *      nor counted;
 *   4. run the shared implementation;
 *   5. redact the result with #2333's shared secret patterns, cap it (and say
 *      `truncated`), attach #2324's instructions and #2325's citations;
 *   6. audit-log user, tool, project and result count — never the result body
 *      and never the arguments. (Not the token id: the audit sink redacts every
 *      `/token/i` key that is not a count, #1268.)
 *
 * No step makes a model call: the client agent does the reasoning.
 */
import { MAX_CODE_CITATION_REFS, type CodeCitationRef } from "@metis/shared";
import { audit as defaultAudit } from "../../lib/audit/audit-service.js";
import { assertLiveProjectAccess } from "../../lib/custom-agents/authz.js";
import { loadCodeAccessFilter } from "../../lib/analysis/tools/code-access.js";
import { redactSecrets } from "../../lib/safety/secret-patterns.js";
import { AppError } from "../../middleware/error-handler.js";
import { McpAuthError, resolveMcpCaller, type McpCaller, type TokenVerifier } from "./identity.js";
import type { IndexToolDef, SharedImpls, SharedResult } from "./tools.js";

/** The most characters of result text one call returns. */
export const MAX_RESULT_CHARS = 24_000;

export const AUDIT_ACTION = "mcp.index.tool_call";
export const AUDIT_DENIED_ACTION = "mcp.index.denied";

/** The structured result a successful call returns (`structuredContent`). */
export interface IndexToolOutput {
  tool: string;
  projectId: string | null;
  /** The shared tool's text, redacted and capped. */
  result: string;
  /** How many results it returned; `null` when the tool does not count (a status report, a file read). */
  resultCount: number | null;
  /** The tool cut its results, or the text was cut at {@link MAX_RESULT_CHARS}. */
  truncated: boolean;
  /** #2325 — one ref per code location returned, with the indexed commit. */
  citations: CodeCitationRef[];
  /** #2324 — read after the result: fixed text from METIS, never from the result. */
  instructions: string | null;
}

export type IndexCallOutcome =
  { isError: false; output: IndexToolOutput } | { isError: true; message: string };

type AuditFn = typeof defaultAudit;

export interface DispatchEnv {
  credential: string;
  impls: SharedImpls;
  verify?: TokenVerifier;
  audit?: AuditFn;
  /** Where operator diagnostics go (stderr: stdout is the MCP transport). */
  log?: (line: string) => void;
}

const defaultLog = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export function projectNotFoundMessage(tool: string): string {
  return `${tool}: project not found. Use metis_list_projects for the ids of the projects you can read.`;
}

/** Cut `text` to {@link MAX_RESULT_CHARS}, saying so at the cut. */
export function capResult(text: string): { text: string; capped: boolean } {
  if (text.length <= MAX_RESULT_CHARS) return { text, capped: false };
  const note = "\n[… truncated by METIS: narrow the query or the line range]";
  return { text: text.slice(0, MAX_RESULT_CHARS - note.length) + note, capped: true };
}

function readProjectId(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const p = (args as { projectId?: unknown }).projectId;
  return typeof p === "string" && p.length > 0 ? p : null;
}

/**
 * Run one tool call as the credential's user. Never throws: every failure is
 * an error outcome whose message says nothing about METIS's internals.
 */
export async function dispatchIndexTool(
  def: IndexToolDef,
  args: unknown,
  env: DispatchEnv,
): Promise<IndexCallOutcome> {
  const audit = env.audit ?? defaultAudit;
  const log = env.log ?? defaultLog;

  let caller: McpCaller;
  try {
    caller = await resolveMcpCaller(env.credential, env.verify);
  } catch (err) {
    if (err instanceof McpAuthError) {
      audit({
        actor: null,
        action: AUDIT_DENIED_ACTION,
        target: { type: "mcp_tool", id: def.name },
        metadata: { tool: def.name, reason: err.reason },
      });
      log(`metis-index-mcp: ${def.name} refused (${err.reason})`);
      return { isError: true, message: err.message };
    }
    log(`metis-index-mcp: ${def.name} could not resolve the caller: ${(err as Error).message}`);
    return { isError: true, message: `${def.name} failed: METIS could not check the credential.` };
  }

  const projectId = def.projectScoped ? readProjectId(args) : null;
  const record = (fields: { resultCount: number | null; isError: boolean; truncated: boolean }) =>
    audit({
      actor: { id: caller.userId },
      action: AUDIT_ACTION,
      target: projectId ? { type: "project", id: projectId } : { type: "user", id: caller.userId },
      metadata: { tool: def.name, projectId, ...fields },
    });

  try {
    if (def.projectScoped) {
      if (!projectId) return { isError: true, message: `${def.name}: projectId is required.` };
      try {
        await assertLiveProjectAccess(caller.actor, projectId);
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 404) {
          record({ resultCount: null, isError: true, truncated: false });
          return { isError: true, message: projectNotFoundMessage(def.name) };
        }
        throw err;
      }
    }
    const codeAccess = projectId
      ? await loadCodeAccessFilter({ projectId, userId: caller.userId })
      : undefined;
    const r: SharedResult = await def.run(args as never, {
      caller,
      projectId,
      ...(codeAccess ? { codeAccess } : {}),
      impls: env.impls,
    });
    const redacted = redactSecrets(r.content).text;
    if (r.isError) {
      record({ resultCount: null, isError: true, truncated: false });
      return { isError: true, message: capResult(redacted).text };
    }
    const capped = capResult(redacted);
    const truncated = r.truncated === true || capped.capped;
    const resultCount = typeof r.resultCount === "number" ? r.resultCount : null;
    record({ resultCount, isError: false, truncated });
    return {
      isError: false,
      output: {
        tool: def.name,
        projectId,
        result: capped.text,
        resultCount,
        truncated,
        citations: (r.citations ?? []).slice(0, MAX_CODE_CITATION_REFS),
        instructions: def.instructionsFor(r) ?? null,
      },
    };
  } catch (err) {
    log(`metis-index-mcp: ${def.name} failed: ${(err as Error).message}`);
    record({ resultCount: null, isError: true, truncated: false });
    return {
      isError: true,
      message: `${def.name} failed. Try again, or check metis_index_status.`,
    };
  }
}
