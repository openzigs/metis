/**
 * Epic #396 / Issue #431 — MCP tool definitions for the
 * `metis-speckit-mcp` stdio server.
 *
 * Each entry maps a stable MCP tool name (`speckit_*` snake_case per MCP
 * convention) to the canonical `speckit.*` REST command and a minimal
 * Zod input schema. Tools are intentionally thin — all business logic
 * stays inside the existing METIS server (the MCP layer is just a
 * transport translation so hosts that speak MCP can use Spec Kit
 * without bespoke HTTP wiring).
 */
import { z } from "zod";
import type { DispatchInput } from "./dispatcher.js";

export interface SpecKitToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** MCP tool name (snake_case). */
  name: string;
  /** Human-readable description shown in `tools/list`. */
  description: string;
  /** Zod schema for the tool's input arguments. */
  inputSchema: Shape;
  /** Maps validated input → REST dispatch payload. */
  toDispatchInput(args: z.infer<z.ZodObject<Shape>>): DispatchInput;
}

/**
 * #309 — the MCP SDK derives `tools/list` JSON Schemas from these shapes, and on
 * zod 4 it converts in `io: "input"` mode, which stops emitting the
 * `additionalProperties: false` zod 3's converter always wrote. Hosts had been
 * told these objects are closed; this metadata keeps telling them so. It is
 * metadata only: unknown keys are still stripped, never rejected.
 */
const CLOSED_OBJECT = { additionalProperties: false } as const;

/**
 * The input schema a tool is registered with (see {@link CLOSED_OBJECT}). An
 * EMPTY shape stays a raw shape: the SDK advertises that as the bare
 * `{ type: "object", properties: {} }` on both zod majors, which is what the
 * no-argument tools have always sent.
 */
export function toolInputSchema<S extends z.ZodRawShape>(shape: S): S | z.ZodObject<S> {
  return Object.keys(shape).length === 0 ? shape : z.object(shape).meta(CLOSED_OBJECT);
}

/**
 * Types each entry against ITS OWN shape. zod 4 infers `unknown` for every key of
 * the default `z.ZodRawShape`, so a bare `satisfies ReadonlyArray<SpecKitToolDef>`
 * no longer gives `toDispatchInput` typed arguments (#309).
 */
function defineTool<const N extends string, S extends z.ZodRawShape>(
  def: SpecKitToolDef<S> & { name: N },
): SpecKitToolDef<S> & { name: N } {
  return def;
}

const featureSlugShape = {
  featureSlug: z.string().min(1).describe("Per-feature slug, e.g. `001-payments-redesign`."),
} as const;

/**
 * #786 — tasks/clarify/analyze/implement run against one feature's
 * `specs/<slug>/` set when given a slug, else against the project's `.specify/`.
 */
const optionalFeatureSlugShape = {
  featureSlug: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Per-feature slug, e.g. `001-payments-redesign`: read and write `specs/<slug>/`. Omit for the project-level `.specify/` set.",
    ),
} as const;

/** The REST body for a tool taking {@link optionalFeatureSlugShape}. */
function featureBody(args: { featureSlug?: string }): Record<string, unknown> {
  return args.featureSlug ? { featureSlug: args.featureSlug } : {};
}

const forceShape = {
  force: z
    .boolean()
    .optional()
    .describe("Set true to bypass phase gates (audited as severity:high)."),
} as const;

export const SPEC_KIT_TOOLS = [
  defineTool({
    name: "speckit_constitution",
    description:
      "Generate or update the project constitution from `.github/instructions/*.md` plus optional overrides. Bumps semver based on principle add/remove/edit.",
    inputSchema: {
      content: z.string().optional().describe("Project-level constitution overrides (markdown)."),
    },
    toDispatchInput: (args) => ({
      command: "speckit.constitution",
      input: args.content ?? "",
    }),
  }),
  defineTool({
    name: "speckit_specify",
    description:
      "Create a new feature: produces `specs/<NNN-slug>/spec.md` with stakeholders, scope, ACs, NFRs.",
    inputSchema: {
      prompt: z.string().min(1).describe("Free-form description of the feature."),
      featureSlug: z
        .string()
        .optional()
        .describe("Optional override for the slug suffix (default derived from title)."),
    },
    toDispatchInput: (args) => ({
      command: "speckit.specify",
      input: args.prompt,
      body: args.featureSlug ? { featureSlug: args.featureSlug } : {},
    }),
  }),
  defineTool({
    name: "speckit_clarify",
    description:
      "Append a clarification Q&A row. Empty input adds a new question; non-empty answers the latest open question.",
    inputSchema: {
      input: z.string().default("").describe("Answer text (empty asks a question)."),
      ...optionalFeatureSlugShape,
      ...forceShape,
    },
    toDispatchInput: (args) => ({
      command: "speckit.clarify",
      input: args.input,
      body: featureBody(args),
      force: args.force ?? false,
    }),
  }),
  defineTool({
    name: "speckit_plan",
    description:
      "Run the expanded planner: emits `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, and `contracts/api.openapi.yaml`. Requires spec gate.",
    inputSchema: { ...featureSlugShape, ...forceShape },
    toDispatchInput: (args) => ({
      command: "speckit.plan",
      body: { featureSlug: args.featureSlug },
      force: args.force ?? false,
    }),
  }),
  defineTool({
    name: "speckit_checklist",
    description:
      "Generate per-domain quality checklists (security, performance, accessibility, observability, testability by default). Requires plan gate.",
    inputSchema: {
      ...featureSlugShape,
      ...forceShape,
      mode: z.enum(["merge", "overwrite"]).optional(),
      domains: z.array(z.string()).optional(),
    },
    toDispatchInput: (args) => ({
      command: "speckit.checklist",
      body: {
        featureSlug: args.featureSlug,
        ...(args.mode ? { mode: args.mode } : {}),
        ...(args.domains ? { domains: args.domains } : {}),
      },
      force: args.force ?? false,
    }),
  }),
  defineTool({
    name: "speckit_tasks",
    description:
      "Generate `tasks.md` with topologically-ordered tasks and Fibonacci sizing. With `featureSlug`, from that feature's spec.md and plan.md (requires plan gate).",
    inputSchema: { ...optionalFeatureSlugShape, ...forceShape },
    toDispatchInput: (args) => ({
      command: "speckit.tasks",
      body: featureBody(args),
      force: args.force ?? false,
    }),
  }),
  defineTool({
    name: "speckit_analyze",
    description:
      "Cross-phase consistency check across spec/plan/tasks; produces `analysis.md`. With `featureSlug`, for that feature (requires tasks gate).",
    inputSchema: { ...optionalFeatureSlugShape, ...forceShape },
    toDispatchInput: (args) => ({
      command: "speckit.analyze",
      body: featureBody(args),
      force: args.force ?? false,
    }),
  }),
  defineTool({
    name: "speckit_implement",
    description:
      "Return the orchestrator handoff payload that picks up `tasks.md` and routes to executors. With `featureSlug`, that feature's artifacts (requires tasks gate).",
    inputSchema: { ...optionalFeatureSlugShape, ...forceShape },
    toDispatchInput: (args) => ({
      command: "speckit.implement",
      body: featureBody(args),
      force: args.force ?? false,
    }),
  }),
  defineTool({
    name: "speckit_taskstoissues",
    description:
      "Plan exporting `tasks.md` rows as GitHub issues (one per task, idempotent on (featureSlug, taskId)). Requires tasks gate. " +
      "Use `dryRun: true` — the supported mode: it returns the planned issues and target repo without calling GitHub or writing anything. " +
      "A real export (dryRun false or omitted) is not available on this server yet and returns HTTP 501 `SPECKIT_ISSUE_EXPORT_UNAVAILABLE`. " +
      "Target repo resolution order: explicit `repo`, then Spec Kit config (`tasksToIssuesRepo`), then the project's saved publish target, " +
      "then the `SPECKIT_TASKS_DEFAULT_REPO` env var; otherwise HTTP 400 `SPECKIT_NO_REPO_CONFIGURED`. Never the analysed repository.",
    inputSchema: {
      ...featureSlugShape,
      ...forceShape,
      repo: z
        .object({ owner: z.string(), name: z.string() })
        .meta(CLOSED_OBJECT)
        .optional()
        .describe("Override the destination repo (otherwise resolved from project config)."),
      parentEpicNumber: z.number().int().positive().optional(),
      dryRun: z
        .boolean()
        .optional()
        .describe(
          "Set true to preview the export: no GitHub calls, no writes. Currently the only supported mode — false/omitted returns 501 SPECKIT_ISSUE_EXPORT_UNAVAILABLE.",
        ),
    },
    toDispatchInput: (args) => ({
      command: "speckit.taskstoissues",
      body: {
        featureSlug: args.featureSlug,
        ...(args.repo ? { repo: args.repo } : {}),
        ...(args.parentEpicNumber !== undefined ? { parentEpicNumber: args.parentEpicNumber } : {}),
        ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
      },
      force: args.force ?? false,
    }),
  }),
] as const;

export type SpecKitToolName = (typeof SPEC_KIT_TOOLS)[number]["name"];

export function findTool(name: string): SpecKitToolDef | undefined {
  return SPEC_KIT_TOOLS.find((t) => t.name === name);
}
