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
  toDispatchInput: (args: z.infer<z.ZodObject<Shape>>) => DispatchInput;
}

const featureSlugShape = {
  featureSlug: z.string().min(1).describe("Per-feature slug, e.g. `001-payments-redesign`."),
} as const;

const forceShape = {
  force: z
    .boolean()
    .optional()
    .describe("Set true to bypass phase gates (audited as severity:high)."),
} as const;

export const SPEC_KIT_TOOLS = [
  {
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
  },
  {
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
  },
  {
    name: "speckit_clarify",
    description:
      "Append a clarification Q&A row. Empty input adds a new question; non-empty answers the latest open question.",
    inputSchema: {
      input: z.string().default("").describe("Answer text (empty asks a question)."),
    },
    toDispatchInput: (args) => ({
      command: "speckit.clarify",
      input: args.input,
    }),
  },
  {
    name: "speckit_plan",
    description:
      "Run the expanded planner: emits `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, and `contracts/api.openapi.yaml`. Requires spec gate.",
    inputSchema: { ...featureSlugShape, ...forceShape },
    toDispatchInput: (args) => ({
      command: "speckit.plan",
      body: { featureSlug: args.featureSlug },
      force: args.force ?? false,
    }),
  },
  {
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
  },
  {
    name: "speckit_tasks",
    description: "Generate `tasks.md` with topologically-ordered tasks and Fibonacci sizing.",
    inputSchema: {},
    toDispatchInput: () => ({ command: "speckit.tasks" }),
  },
  {
    name: "speckit_analyze",
    description: "Cross-phase consistency check across spec/plan/tasks; produces `analysis.md`.",
    inputSchema: {},
    toDispatchInput: () => ({ command: "speckit.analyze" }),
  },
  {
    name: "speckit_implement",
    description:
      "Return the orchestrator handoff payload that picks up `tasks.md` and routes to executors.",
    inputSchema: {},
    toDispatchInput: () => ({ command: "speckit.implement" }),
  },
  {
    name: "speckit_taskstoissues",
    description:
      "Materialize `tasks.md` rows as GitHub issues (idempotent on (featureSlug, taskId)). Requires tasks gate.",
    inputSchema: {
      ...featureSlugShape,
      ...forceShape,
      repo: z
        .object({ owner: z.string(), name: z.string() })
        .optional()
        .describe("Override the destination repo (otherwise resolved from project config)."),
      parentEpicNumber: z.number().int().positive().optional(),
      dryRun: z.boolean().optional(),
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
  },
] as const satisfies ReadonlyArray<SpecKitToolDef>;

export type SpecKitToolName = (typeof SPEC_KIT_TOOLS)[number]["name"];

export function findTool(name: string): SpecKitToolDef | undefined {
  return SPEC_KIT_TOOLS.find((t) => t.name === name);
}
