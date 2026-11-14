/**
 * #2331 — the `metis_*` tools of `metis-index-mcp`.
 *
 * Each tool is a thin mapping onto the implementation chat already runs, never
 * a second search path:
 *
 *   - the code tools are taken from `getChatCodeTools` itself (the curated chat
 *     set, with the #2325 citation contract), by their chat names;
 *   - `metis_read_requirements` is chat's `list_requirements` / `get_requirement`;
 *   - `metis_list_projects` reads the projects the caller may access under the
 *     rule every project-scoped surface uses (`accessibleProjectWhere`).
 *
 * Inputs are bounded zod shapes: every string has a maximum length, the kinds,
 * languages and statuses are enums, and every limit is capped at the shared
 * tool's own cap. The SDK validates them before a handler runs.
 *
 * The descriptions are written for an EXTERNAL agent, which sees these names
 * (not chat's), and carry #2324's search guidance in short form: when to use
 * the tool, what a good query looks like, what to try after an empty result.
 */
import { z } from "zod";
import { REQUIREMENT_REVIEW_STATUSES, type CodeCitationRef } from "@metis/shared";
import { prisma } from "../../lib/prisma.js";
import { accessibleProjectWhere } from "../../lib/acp/authz.js";
import { getChatCodeTools, type ChatCodeToolDeps } from "../../lib/analysis/tools/index.js";
import type { AgentTool, ToolResult, ZeroResultKind } from "../../lib/analysis/tools/types.js";
import type { CodeAccessFilter } from "../../lib/analysis/tools/code-access.js";
import {
  SYMBOL_KINDS,
  SYMBOL_LANGUAGES,
  MAX_LIMIT as MAX_SYMBOL_LIMIT,
} from "../../lib/analysis/tools/search-symbols.js";
import { MAX_SPANS } from "../../lib/analysis/tools/search-code-context.js";
import { INDEX_STATUS_TOOL_NAME } from "../../lib/analysis/tools/index-status.js";
import {
  createGetRequirementTool,
  createListRequirementsTool,
  type RequirementToolsDeps,
} from "../../lib/requirements/requirements-chat-tools.js";
import type { ToolDefinition } from "../../lib/ai/types.js";
import { resultInstructions } from "../../lib/ai/search-guidance.js";
import type { McpCaller } from "./identity.js";

/** Most projects `metis_list_projects` returns. */
export const MAX_PROJECTS = 200;
/** A project description is cut to its first line, at most this long. */
export const MAX_DESCRIPTION_CHARS = 200;
const MAX_REQUIREMENTS = 100;
const MAX_LINE = 1_000_000;

/** What a shared implementation returned, in the code tools' shape. */
export interface SharedResult {
  content: string;
  isError?: boolean;
  resultCount?: number;
  truncated?: boolean;
  zeroResultKind?: ZeroResultKind;
  citations?: CodeCitationRef[];
}

/** The implementations chat runs, built once per server. */
export interface SharedImpls {
  /** Chat's code tools, by their chat name. */
  code: ReadonlyMap<string, AgentTool>;
  listRequirements: ToolDefinition;
  getRequirement: ToolDefinition;
}

export interface SharedImplDeps {
  /** Test seams for the hybrid searcher (`getChatCodeTools`'s own). */
  code?: ChatCodeToolDeps;
  requirements?: RequirementToolsDeps;
}

/**
 * Chat's code tools, with every optional one on: the index status tool, the
 * search primitives' symbol filters (#2327) and `search_code_context` (#2329).
 */
export function buildSharedImpls(deps: SharedImplDeps = {}): SharedImpls {
  const code = getChatCodeTools(
    { ...deps.code, codeContext: true },
    { indexStatus: true, primitives: true },
  );
  return {
    code: new Map(code.map((t) => [t.name, t])),
    listRequirements: createListRequirementsTool(deps.requirements) as unknown as ToolDefinition,
    getRequirement: createGetRequirementTool(deps.requirements) as unknown as ToolDefinition,
  };
}

/** Everything one call runs with, resolved by the dispatcher before {@link IndexToolDef.run}. */
export interface IndexToolContext {
  caller: McpCaller;
  /** The project the call is scoped to (`null` for a tool that takes none). */
  projectId: string | null;
  /** The caller's document-ACL filter in that project. */
  codeAccess?: CodeAccessFilter;
  impls: SharedImpls;
}

export interface IndexToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  /** Takes a `projectId` the caller must be able to read. */
  projectScoped: boolean;
  run(args: z.infer<z.ZodObject<Shape>>, ctx: IndexToolContext): Promise<SharedResult>;
  /** The fixed, server-authored `instructions` for one result (#2324). */
  instructionsFor(result: SharedResult): string | undefined;
}

function defineTool<S extends z.ZodRawShape>(def: IndexToolDef<S>): IndexToolDef<S> {
  return def;
}

const projectIdShape = {
  projectId: z.string().min(1).max(128).describe("The project's id, from metis_list_projects."),
} as const;

const queryShape = {
  query: z
    .string()
    .min(1)
    .max(500)
    .describe("Two to five words in the code's own vocabulary, not the whole question."),
} as const;

const symbolShape = {
  symbol: z
    .string()
    .min(1)
    .max(300)
    .describe("The symbol's name; its qualified name when the bare name is ambiguous."),
} as const;

/** Grounding results read #2324's instructions, as the chat tool of the same implementation. */
const groundedAs =
  (chatName: string) =>
  (r: SharedResult): string | undefined =>
    resultInstructions(chatName, r);

/** Read a shared code tool by its chat name; built by {@link buildSharedImpls}, so always there. */
function codeTool(ctx: IndexToolContext, chatName: string): AgentTool {
  const tool = ctx.impls.code.get(chatName);
  if (!tool) throw new Error(`chat code tool ${chatName} is not built`);
  return tool;
}

async function runCode(
  ctx: IndexToolContext,
  chatName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return codeTool(ctx, chatName).execute(args, {
    projectId: ctx.projectId as string,
    ...(ctx.codeAccess ? { codeAccess: ctx.codeAccess } : {}),
  });
}

/** Drop the `projectId` the MCP layer consumed: the shared tool is scoped by its context. */
function withoutProject<T extends { projectId?: string }>(args: T): Omit<T, "projectId"> {
  const { projectId: _projectId, ...rest } = args;
  return rest;
}

/** A requirement tool's `ToolResult` in the code tools' shape. */
function fromRegistryResult(r: {
  text: string;
  isError?: boolean;
  resultCount?: number;
}): SharedResult {
  return {
    content: r.text,
    ...(r.isError ? { isError: true } : {}),
    ...(typeof r.resultCount === "number" ? { resultCount: r.resultCount } : {}),
  };
}

export const LIST_PROJECTS_INSTRUCTIONS =
  "Instructions from METIS, not the tool: pass the id of the project the question is about as " +
  "projectId to the other metis_ tools. A project not listed here is not one you can read.";

export const INDEX_STATUS_INSTRUCTIONS =
  "Instructions from METIS, not the tool: while an index is failed, partial or still being " +
  "built, an empty search does not show that the code lacks something; say so when you answer.";

/** The first line of a project description, cut to {@link MAX_DESCRIPTION_CHARS}. */
export function oneLine(description: string): string {
  const first = (description.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
  return first.length > MAX_DESCRIPTION_CHARS
    ? `${first.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
    : first;
}

export const INDEX_TOOLS = [
  defineTool({
    name: "metis_list_projects",
    description:
      "List the METIS projects you can read: id, name, slug and a one-line description to route " +
      "a question by. Call it first, then pass the id of the project the question is about as " +
      "projectId to the other metis_ tools.",
    inputSchema: {},
    projectScoped: false,
    async run(_args, ctx) {
      const rows = await prisma.project.findMany({
        where: { ...accessibleProjectWhere(ctx.caller.actor), status: { not: "archived" } },
        select: { id: true, name: true, slug: true, description: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: MAX_PROJECTS + 1,
      });
      const truncated = rows.length > MAX_PROJECTS;
      const shown = truncated ? rows.slice(0, MAX_PROJECTS) : rows;
      if (shown.length === 0)
        return { content: "You cannot read any METIS project.", resultCount: 0 };
      const lines = shown.map((p) => {
        const about = oneLine(p.description);
        return `- ${p.id} — ${p.name} (${p.slug})${about ? `: ${about}` : ""}`;
      });
      const header = truncated
        ? `The first ${MAX_PROJECTS} projects you can read, by name.`
        : `${shown.length} project${shown.length === 1 ? "" : "s"} you can read.`;
      return {
        content: `${header}\n${lines.join("\n")}`,
        resultCount: shown.length,
        ...(truncated ? { truncated: true } : {}),
      };
    },
    instructionsFor: (r) => (r.isError ? undefined : LIST_PROJECTS_INSTRUCTIONS),
  }),
  defineTool({
    name: "metis_search_code_context",
    description:
      "Answer-oriented code search: the whole functions and classes that answer a question about " +
      "a project's code, adjacent matches merged, each with a file:line locator and the indexed " +
      "commit. When: you need the code behind a behaviour or business term. Empty result: reword " +
      "with a synonym or the likely identifier, or try metis_search_symbols.",
    inputSchema: {
      ...projectIdShape,
      ...queryShape,
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_SPANS)
        .optional()
        .describe(`Most spans to return (1-${MAX_SPANS}).`),
    },
    projectScoped: true,
    run: (args, ctx) => runCode(ctx, "search_code_context", withoutProject(args)),
    // Ranked by the same searcher as search_code_symbols, so it reads that tool's instructions.
    instructionsFor: groundedAs("search_code_symbols"),
  }),
  defineTool({
    name: "metis_search_symbols",
    description:
      "Keyword + semantic search over a project's code symbols (functions, classes, methods), " +
      "each with a file:line locator and the indexed commit. Narrow with fileGlob, symbolKind or " +
      "language. Empty result: reword with a synonym or the identifier spelling, then try " +
      "metis_search_code_context, or metis_graph_callers with a name.",
    inputSchema: {
      ...projectIdShape,
      ...queryShape,
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_SYMBOL_LIMIT)
        .optional()
        .describe(`Most hits to return (1-${MAX_SYMBOL_LIMIT}).`),
      fileGlob: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Only files matching this repository-relative glob, e.g. 'internal/reader/**'."),
      symbolKind: z.enum(SYMBOL_KINDS).optional().describe("Only symbols of this kind."),
      language: z.enum(SYMBOL_LANGUAGES).optional().describe("Only files of this language."),
    },
    projectScoped: true,
    run: (args, ctx) => runCode(ctx, "search_code_symbols", withoutProject(args)),
    instructionsFor: groundedAs("search_code_symbols"),
  }),
  defineTool({
    name: "metis_graph_callers",
    description:
      "The symbols that call the named symbol, from the project's code graph, plus probable call " +
      "sites the parser could not resolve. Read a call with metis_read_file_slice before you " +
      "state that one function calls another.",
    inputSchema: { ...projectIdShape, ...symbolShape },
    projectScoped: true,
    // `search_code_graph`'s `calls`: "find symbols that call the named symbol".
    run: (args, ctx) => runCode(ctx, "search_code_graph", { calls: args.symbol }),
    instructionsFor: groundedAs("search_code_graph"),
  }),
  defineTool({
    name: "metis_graph_callees",
    description:
      "The symbols the named symbol calls, from the project's code graph, plus calls the parser " +
      "could not resolve. Read a call with metis_read_file_slice before you state that one " +
      "function calls another.",
    inputSchema: { ...projectIdShape, ...symbolShape },
    projectScoped: true,
    // `search_code_graph`'s `calledBy`: "find symbols that are called by the named symbol".
    run: (args, ctx) => runCode(ctx, "search_code_graph", { calledBy: args.symbol }),
    instructionsFor: groundedAs("search_code_graph"),
  }),
  defineTool({
    name: "metis_read_file_slice",
    description:
      "Read up to 200 numbered lines of a file in the project's repository, to confirm a search " +
      "hit and quote the lines you cite. Take the exact path from a search result and ask for a " +
      "narrow range around the locator.",
    inputSchema: {
      ...projectIdShape,
      filePath: z
        .string()
        .min(1)
        .max(1024)
        .describe("Repository-relative path, exactly as a search result gave it."),
      startLine: z.number().int().min(1).max(MAX_LINE).optional().describe("1-based, inclusive."),
      endLine: z
        .number()
        .int()
        .min(1)
        .max(MAX_LINE)
        .optional()
        .describe("1-based, inclusive; at most 200 lines after startLine."),
    },
    projectScoped: true,
    run: (args, ctx) => runCode(ctx, "read_file_slice", withoutProject(args)),
    instructionsFor: groundedAs("read_file_slice"),
  }),
  defineTool({
    name: "metis_read_requirements",
    description:
      "Read the project's METIS requirements. Without requirementId: list them, filtered by " +
      "review status, label or a query matched by meaning and by words. With requirementId: one " +
      "requirement in full, with acceptance criteria, code links, data mappings and its " +
      "requirement → spec → code trace.",
    inputSchema: {
      ...projectIdShape,
      requirementId: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Read this requirement in full (an id from a listing)."),
      status: z.enum(REQUIREMENT_REVIEW_STATUSES).optional().describe("List: only this status."),
      label: z.string().min(1).max(200).optional().describe("List: only this label."),
      query: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe("List: what to look for, in the analyst's own words."),
      limit: z.number().int().min(1).max(MAX_REQUIREMENTS).optional(),
    },
    projectScoped: true,
    async run(args, ctx) {
      const toolCtx = {
        sessionId: `mcp:${ctx.caller.tokenId}`,
        userId: ctx.caller.userId,
        projectId: ctx.projectId as string,
      };
      if (args.requirementId !== undefined) {
        const tool = ctx.impls.getRequirement;
        return fromRegistryResult(
          await tool.exec(tool.schema.parse({ requirementId: args.requirementId }), toolCtx),
        );
      }
      const tool = ctx.impls.listRequirements;
      const { requirementId: _id, ...list } = withoutProject(args);
      return fromRegistryResult(await tool.exec(tool.schema.parse(list), toolCtx));
    },
    // Project sources, read as search-knowledge's are.
    instructionsFor: groundedAs("search-knowledge"),
  }),
  defineTool({
    name: "metis_index_status",
    description:
      "The state of a project's index: per repository, the last indexed commit and time, how the " +
      "last indexing run ended, and how many symbols, documents and files it holds. Call it " +
      "before concluding that the project lacks something your searches did not find.",
    inputSchema: { ...projectIdShape },
    projectScoped: true,
    run: (_args, ctx) => runCode(ctx, INDEX_STATUS_TOOL_NAME, {}),
    instructionsFor: (r) => (r.isError ? undefined : INDEX_STATUS_INSTRUCTIONS),
  }),
] as const;

export type IndexToolName = (typeof INDEX_TOOLS)[number]["name"];

export function findIndexTool(name: string): IndexToolDef | undefined {
  return (INDEX_TOOLS as readonly IndexToolDef[]).find((t) => t.name === name);
}
