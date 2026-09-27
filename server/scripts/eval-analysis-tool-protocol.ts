/**
 * #141 / #214 — `pnpm eval:analysis-tools` entrypoint: run the analysis
 * agentic code pass on the SAME corpus, model and project twice per run —
 * `ANALYSIS_NATIVE_TOOL_CALLS` off (text protocol) and on (native tool calls) —
 * and report findings validity, the degraded-pass rate, tool-call errors and
 * tokens per run for each.
 *
 *   pnpm eval:analysis-tools --project <projectId> --cases <corpus.json> --dry-run
 *   pnpm eval:analysis-tools --project <projectId> --cases <corpus.json> \
 *     [--connector <connectorId>] [--model <id>] [--runs 3] [--modes text,native] \
 *     [--max-turns 8] [--max-tokens 40000] [--out <dir>]
 *
 * `<corpus.json>` is an array of
 * `{ "id": "...", "requirements": [{ "id": "...", "text": "..." }], "extraInstructions"?: "..." }`.
 * The project must already be ingested (code graph + symbols): the tools are
 * the orchestrator's own (`assembleAgenticCodeTools`), run against the database
 * and index this process is configured for. `--connector` adds the file tools
 * when that connector's clone is on disk.
 *
 * Each case's prompt carries the same seeded blocks a real run does — fused
 * code-graph context, and (from `extraInstructions`) the affected-code and
 * affected-schema blocks, gated on the project's own database-aware decision —
 * built by the orchestrator's shared `agentic-pass-context` functions, and the
 * loop gets the orchestrator's budget after their token carve-out.
 *
 * The provider is built exactly as the analysis route builds it (the direct
 * OpenAI-compatible client for `bedrock-gateway` / `local-gemma`, the factory
 * otherwise) from the usual AI_* configuration. THIS CALLS THAT MODEL — every
 * case × run × mode is one full agentic pass. `--dry-run` resolves everything
 * (provider, model, tools, which protocol each mode would use) and exits
 * without a single model call. A real run on the offline stub is refused: it
 * answers nothing parseable, so both columns would be noise.
 *
 * All logic lives in the unit-tested `src/lib/eval/analysis-tool-protocol/`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildProvider, loadAIConfig, type AIProvider } from "../src/lib/ai/index.js";
import { BedrockDirectProvider } from "../src/lib/ai/providers/bedrock-direct-provider.js";
import { resolveAnalysisNativeTools } from "../src/lib/analysis/agent-loop.js";
import { assembleAgenticCodeTools } from "../src/lib/analysis/orchestrator.js";
import {
  assembleAgenticPassSeeds,
  resolveDatabaseAwareDecision,
} from "../src/lib/analysis/agentic-pass-context.js";
import { prisma } from "../src/lib/prisma.js";
import { resolveExistingCloneDir } from "../src/lib/analysis/clone-availability.js";
import { getKnowledgeService } from "../src/lib/rag/knowledge-service.js";
import {
  formatProtocolComparison,
  parseProtocolCases,
  runToolProtocolComparison,
  type ProtocolMode,
} from "../src/lib/eval/analysis-tool-protocol/harness.js";

function analysisProvider(): AIProvider {
  const config = loadAIConfig();
  if (
    (config.provider === "bedrock-gateway" || config.provider === "local-gemma") &&
    config.sdkProvider
  ) {
    return new BedrockDirectProvider({
      baseUrl: config.sdkProvider.baseUrl,
      apiKey: config.sdkProvider.apiKey ?? "",
      model: config.model,
      providerKey: config.provider,
      modelProfileMap: config.modelProfileMap,
    });
  }
  return buildProvider({ config });
}

function positiveInt(raw: string | undefined, name: string, fallback?: number): number | undefined {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      connector: { type: "string" },
      cases: { type: "string" },
      model: { type: "string" },
      runs: { type: "string" },
      modes: { type: "string", default: "text,native" },
      "max-turns": { type: "string" },
      "max-tokens": { type: "string" },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.project || !values.cases) {
    throw new Error("--project <projectId> and --cases <corpus.json> are required");
  }
  const modes = values.modes.split(",").map((m) => m.trim()) as ProtocolMode[];
  if (modes.length === 0 || modes.some((m) => m !== "text" && m !== "native")) {
    throw new Error("--modes takes a comma-separated list of text,native");
  }
  const cases = parseProtocolCases(JSON.parse(await readFile(path.resolve(values.cases), "utf8")));
  const runsPerCase = positiveInt(values.runs, "runs", 1)!;
  const maxTurns = positiveInt(values["max-turns"], "max-turns", 8)!;
  const maxTokens = positiveInt(values["max-tokens"], "max-tokens");

  const project = await prisma.project.findUnique({
    where: { id: values.project },
    select: { name: true, description: true, databaseAwareAnalysis: true },
  });
  if (!project) throw new Error(`project ${values.project} not found`);
  const projectId = values.project;
  const databaseAware = await resolveDatabaseAwareDecision(
    projectId,
    project.databaseAwareAnalysis,
  );

  const provider = analysisProvider();
  const model = values.model ?? provider.model;
  const cloneDir = await resolveExistingCloneDir(values.connector);
  const tools = assembleAgenticCodeTools({ knowledgeService: getKnowledgeService(), cloneDir });
  const toolContext = { projectId, connectorId: values.connector, cloneDir };
  const buildPass = async (c: (typeof cases)[number]) => ({
    projectName: project.name,
    projectDescription: project.description,
    requirements: c.requirements,
    seeds: await assembleAgenticPassSeeds({
      projectId,
      projectName: project.name,
      projectDescription: project.description,
      extraInstructions: c.extraInstructions,
      requirements: c.requirements,
      databaseAware: databaseAware.enabled,
    }),
    fileToolsAvailable: cloneDir !== undefined,
    tools,
    toolContext,
  });

  const plan = modes.map((mode) => {
    const saved = process.env.ANALYSIS_NATIVE_TOOL_CALLS;
    process.env.ANALYSIS_NATIVE_TOOL_CALLS = mode === "native" ? "true" : "false";
    const native = resolveAnalysisNativeTools(provider, model, tools);
    if (saved === undefined) delete process.env.ANALYSIS_NATIVE_TOOL_CALLS;
    else process.env.ANALYSIS_NATIVE_TOOL_CALLS = saved;
    return `${mode} → ${native ? "native tool calls" : "text protocol"}`;
  });
  // eslint-disable-next-line no-console
  console.log(
    [
      `provider: ${provider.key}   model: ${model}`,
      `cases: ${cases.length}   runs per case: ${runsPerCase}   passes: ${cases.length * runsPerCase * modes.length}`,
      `tools: ${tools.map((t) => t.name).join(", ")}`,
      `database-aware: ${databaseAware.enabled ? "on" : "off"} (${databaseAware.reason})`,
      ...plan,
    ].join("\n"),
  );
  if (values["dry-run"]) return;
  if (provider.offline || provider.key === "offline-stub") {
    throw new Error(
      "refusing to compare on the offline stub: configure a real AI provider (AI_PROVIDER / AI_MODEL)",
    );
  }

  const comparison = await runToolProtocolComparison({
    provider,
    model,
    cases,
    buildPass,
    modes,
    runsPerCase,
    maxTurns,
    ...(maxTokens ? { maxTokens } : {}),
    onRecord: (r) =>
      // eslint-disable-next-line no-console
      console.log(
        `${r.caseId} run ${r.run} ${r.mode}: ${r.protocol}, valid=${r.findingsValid}, ` +
          `turns=${r.turnsUsed}, tools=${r.toolCalls} (${r.toolErrors} err), tokens=${r.usage.totalTokens}` +
          (r.error ? `, error=${r.error}` : ""),
      ),
  });
  const md = formatProtocolComparison(comparison);
  // eslint-disable-next-line no-console
  console.log(`\n${md}`);
  if (values.out) {
    const dir = path.resolve(values.out);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "analysis-tool-protocol.json"),
      JSON.stringify(comparison, null, 2),
    );
    await writeFile(path.join(dir, "analysis-tool-protocol.md"), `${md}\n`);
    // eslint-disable-next-line no-console
    console.log(`\nwrote ${dir}/analysis-tool-protocol.{json,md}`);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`eval:analysis-tools failed: ${(err as Error).message}`);
    process.exit(1);
  },
);
