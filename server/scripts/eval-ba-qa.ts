/**
 * #2237 — `pnpm eval:ba-qa`: measure how chat answers a business analyst's
 * questions (Phase 0 of #2228), before any default changes.
 *
 *   pnpm eval:materialize baqa-01-acme-reader            # once: clones, projects, code graph
 *   pnpm eval:ba-qa --arm off --budget 5                  # today's chat, flags off
 *   pnpm eval:ba-qa --arm on --budget 5 --include <off>.json   # flags on, reported beside off
 *   pnpm eval:ba-qa --arm off --budget 1 --questions S1,A1     # a smoke run
 *   pnpm eval:ba-qa --floor-sweep                         # #2241: calibrate the relevance floor ($0)
 *
 * Over the two materialized products of `eval-data/corpus/baqa-01-acme-reader/`
 * it asks every question as its own one-turn chat session, on the configured
 * provider, through production's own chat pieces (the session's tools, the
 * library system prompt, the auto-RAG block, `prepareTurn`, `runChatToolTurn`),
 * as `eval-chat-cache.ts` does. A question over two products is asked the way
 * chat takes it today: the session degrades to unscoped (`chatSessionScope`).
 *
 * Before the first question each product gets what an analyst's project holds:
 * the repository's README and manifest and its source files as knowledge
 * documents (the connector's own ingest), and the corpus's uploaded documents
 * (the man page, FRD-12). Idempotent: a product that already holds them is left.
 *
 * #2327 — `tools-primitives` is `tools-only` plus `CHAT_CODE_SEARCH_PRIMITIVES`
 * (`grep_files`, `list_files`, the symbol filters); each session records the
 * tools it called (`toolNames`).
 *
 * Arms (#2243): `off` sets `CHAT_CODE_SEARCH_TOOLS`, `CHAT_FUSED_CODE_RETRIEVAL`
 * and `RAG_RERANK` off and `on` sets all three, whatever the shell or `.env` set;
 * `no-tools`, `no-fused` and `no-rerank` take one flag away from `on`; `default`
 * unsets all three, so each reads the server's default.
 *
 * Each answer is graded by one judge call (`judge.ts`); every rate is computed
 * from its verdicts in code (`metrics.ts`). Spend is ledger-priced, answers and
 * judge apart, and held under `--budget` (USD): the run stops before a question
 * once the cap is reached, once the costliest question so far would carry the
 * spend past it, or on an unpriced call (`budgetStop`). The cap is checked
 * between questions, not within one, so a question costlier than any before it
 * can still cross it.
 * Results: `eval-results/ba-qa/<runId>.{json,md}`.
 *
 * #2241 — `--floor-sweep` asks no model: after the knowledge step it runs chat's
 * knowledge search (k 8, as the asking user, flags off) for every question over
 * each product in its scope, and reports what each candidate relevance floor
 * would drop (`relevance-floor.ts`). Results: `eval-results/ba-qa/<runId>-floor.{json,md}`.
 */
/* eslint-disable no-console -- a local CLI whose output is the report */
import "./eval-ba-qa-env.js";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync, promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  assertEvalDatabase,
  EVAL_USER_EMAIL,
  materializeLayout,
  readMaterializedState,
  type MaterializedRepo,
} from "../src/lib/eval/localization/materialize.js";
import {
  BAQA_CORPUS,
  baQaCorpusDir,
  loadBaQaFixture,
  type BaQaProduct,
  type BaQaQuestion,
} from "../src/lib/eval/ba-qa/fixture.js";
import { extractCitations, type CitableProduct } from "../src/lib/eval/ba-qa/citations.js";
import { buildJudgeMessages, parseJudgeVerdict } from "../src/lib/eval/ba-qa/judge.js";
import { scoreQuestion, summarizeArm, type ArmSummary } from "../src/lib/eval/ba-qa/metrics.js";
import {
  formatFloorSweep,
  OFF_TOPIC_PROBES,
  safestFloor,
  sweepFloors,
  type RetrievalSample,
} from "../src/lib/eval/ba-qa/relevance-floor.js";
import { formatBaQaReport, type ReportSession } from "../src/lib/eval/ba-qa/report.js";
import {
  answerableIn,
  DEFAULT_ROUTING_OPTIONS,
  evidenceFromHits,
  formatRoutingReport,
  parseRoutingFixture,
  routeProjects,
  scopeOf,
  summarizeRetrieval,
  summarizeRouting,
  rankAcrossProjects,
  type ProbeEvidence,
  type ProbeHit,
  type RetrievalRun,
  type RoutingFixture,
  type RoutingQuestion,
  type RoutingSample,
} from "../src/lib/eval/ba-qa/routing.js";
import {
  applyArmEnv,
  assertComparable,
  budgetStop,
  buildJudgedSpans,
  chatSessionScope,
  parseArm,
  unknownSources,
} from "../src/lib/eval/ba-qa/run.js";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(SERVER_DIR, "..");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** #2336 — one project of the routing pool. */
interface PoolProject {
  projectId: string;
  /** Uploaded filename → the path a source names it by. */
  logical: ReadonlyMap<string, string>;
}

interface Session extends ReportSession {
  questionId: string;
  sessionId: string;
  seconds: number;
  turnsUsed: number;
  hasFinalAnswer: boolean;
  response: string;
  ambiguousCitations: string[];
  judgeReply: string;
  usage: { promptTokens: number; completionTokens: number; calls: number };
}

interface Envelope {
  kind: "ba-qa";
  runId: string;
  provider: string;
  model: string;
  judgeModel: string;
  fixture: { id: string; version: number };
  arm: string;
  flags: Record<string, string>;
  summary: ArmSummary;
  sessions: Session[];
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      arm: { type: "string" },
      budget: { type: "string" },
      questions: { type: "string" },
      limit: { type: "string" },
      out: { type: "string" },
      include: { type: "string", multiple: true },
      "judge-model": { type: "string" },
      "floor-sweep": { type: "boolean" },
      "routing-sweep": { type: "boolean" },
      "routing-scope": { type: "string" },
      route: { type: "string" },
    },
  });
  // #2336 — the routing sweep, like the floor sweep, asks no model.
  const routingSweep = values["routing-sweep"] === true;
  if (routingSweep && values["routing-scope"] !== undefined) {
    throw new Error("--routing-sweep asks no model: it takes no --routing-scope");
  }
  const floorSweep = values["floor-sweep"] === true || routingSweep;
  if (!values.arm && !floorSweep) {
    throw new Error("--arm is required (default, off, on, no-tools, …)");
  }
  // #2241 — the sweep measures the search with the flags off.
  const arm = floorSweep ? parseArm("off") : parseArm(values.arm!);
  const budget = Number(values.budget);
  if (!floorSweep && (!values.budget || !Number.isFinite(budget) || budget <= 0)) {
    throw new Error("--budget <usd> is required: the run's spend cap");
  }
  // Before any module reads a flag.
  const flags = applyArmEnv(process.env, arm);

  const corpusDir = baQaCorpusDir(REPO_ROOT, BAQA_CORPUS);
  const fixture = await loadBaQaFixture(corpusDir);
  let questions: BaQaQuestion[] = fixture.questions;
  if (values.questions) {
    const wanted = new Set(values.questions.split(",").map((s) => s.trim()));
    questions = questions.filter((q) => wanted.has(q.id));
  }
  if (values.limit) questions = questions.slice(0, Number(values.limit));
  if (questions.length === 0) throw new Error("no questions selected");

  const layout = materializeLayout();
  const state = await readMaterializedState(BAQA_CORPUS, layout);
  if (!state) throw new Error(`run pnpm eval:materialize ${BAQA_CORPUS} first`);
  const repos = new Map<string, MaterializedRepo>();
  for (const p of fixture.products) {
    const repo = state.repos.find((r) => r.name === p.name);
    if (!repo || repo.sha !== p.sha) {
      throw new Error(`${p.name} is not materialized at ${p.sha}: re-run pnpm eval:materialize`);
    }
    if (git(repo.cloneDir, ["rev-parse", "HEAD"]) !== p.sha) {
      throw new Error(`the ${p.name} clone moved off ${p.sha}: re-run pnpm eval:materialize`);
    }
    repos.set(p.name, repo);
  }

  // What each product's answer can cite: its repository files and its uploads.
  const citable = new Map<string, CitableProduct>(
    fixture.products.map((p) => [
      p.name,
      {
        name: p.name,
        files: git(repos.get(p.name)!.cloneDir, ["ls-files"]).split("\n").filter(Boolean),
        documents: new Map(
          p.documents.map((d) => [d.uploadAs, d.fromCorpus ? d.uploadAs : d.file] as const),
        ),
      },
    ]),
  );
  // Before anything is spent: a source no citation can resolve to would only
  // lower its question's recall, silently.
  const unknown = unknownSources(fixture.questions, citable);
  if (unknown.length > 0) {
    throw new Error(`expected sources that name no file or document: ${unknown.join(", ")}`);
  }

  const { prisma, boundDatabaseUrl } = await import("../src/lib/prisma.js");
  assertEvalDatabase(boundDatabaseUrl, layout);
  const { getEmbedder } = await import("../src/lib/rag/embedder.js");
  if (getEmbedder().model !== state.embedModel) {
    throw new Error(
      `the embedder is ${getEmbedder().model}, the symbols were embedded with ${state.embedModel}`,
    );
  }
  const { buildProvider, loadAIConfig } = await import("../src/lib/ai/index.js");
  const { LedgerCostMeter, meterProvider } = await import("../src/lib/eval/localization/cost.js");
  const {
    resolveSessionTools,
    loadSessionToolsFlags,
    offersSearchGuidance,
    sessionGate,
    withoutApprovalGatedTools,
  } = await import("../src/lib/ai/tool-runtime/session-tools.js");
  const { runChatToolTurn } = await import("../src/lib/ai/tool-runtime/chat-turn.js");
  const { prepareTurn, loadChatTurnConfig } = await import("../src/lib/ai/conversation/turn.js");
  const { chatToolLoopPromptCaching } = await import("../src/lib/ai/chat-prompt-caching.js");
  const { buildAutoRagContext, buildLibrarySystemMessages, NATIVE_CHAT_TOOL_NOTE } =
    await import("../src/routes/ai.js");
  const { buildMultiProjectRagContext } = await import("../src/lib/ai/multi-project-rag.js");
  const { ingestRepoMetadata, ingestSourceAsKnowledge } =
    await import("../src/lib/connectors/connector-ingest.js");
  const { getDocumentStorage } = await import("../src/lib/documents/storage.js");
  const { getKnowledgeService } = await import("../src/lib/rag/knowledge-service.js");
  const { approveDocument } = await import("../src/lib/rag/quarantine.js");

  const user = await prisma.user.upsert({
    where: { email: EVAL_USER_EMAIL },
    create: {
      email: EVAL_USER_EMAIL,
      displayName: "eval-materialize",
      username: "eval-materialize",
    },
    update: {},
  });

  /**
   * Upload `docs` to a project as an analyst would, and approve them out of
   * quarantine. Returns how many were uploaded; an unchanged, indexed upload is left.
   */
  async function ensureUploads(
    projectId: string,
    label: string,
    docs: readonly { uploadAs: string; text: string }[],
  ): Promise<number> {
    const storage = getDocumentStorage();
    let uploaded = 0;
    for (const d of docs) {
      const checksum = crypto.createHash("sha256").update(d.text).digest("hex");
      const existing = await prisma.document.findMany({
        where: { projectId, filename: d.uploadAs, deletedAt: null },
        select: { id: true, checksum: true, indexState: true },
      });
      if (existing.some((e) => e.checksum === checksum && e.indexState === "indexed")) continue;
      // A stale or half-ingested copy is replaced, never left beside the new one. It
      // goes BEFORE the write: a delete removes the content-addressed blob, which
      // the new copy of the same text would share.
      for (const e of existing) await getKnowledgeService().deleteDocument(e.id);
      const stored = await storage.write({ projectId, buffer: Buffer.from(d.text) });
      const doc = await prisma.document.create({
        data: {
          projectId,
          filename: d.uploadAs,
          mimeType: d.uploadAs.endsWith(".md") ? "text/markdown" : "text/plain",
          sizeBytes: stored.sizeBytes,
          storagePath: stored.storagePath,
          checksum: stored.checksum,
          uploadedById: user.id,
          status: "pending",
        },
      });
      await getKnowledgeService().ingestDocument(doc.id);
      // An upload waits in quarantine for a person to approve it, as in the app.
      const after = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
      if (after.indexState === "quarantined") {
        await approveDocument(doc.id, { id: user.id, role: "admin" });
      }
      const settled = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
      if (settled.indexState !== "indexed") {
        throw new Error(`${label}: ${d.uploadAs} ended ${settled.status}/${settled.indexState}`);
      }
      uploaded++;
    }
    return uploaded;
  }

  /** What an analyst's project holds besides the code graph: documents and source chunks. */
  async function ensureKnowledge(
    p: Pick<BaQaProduct, "name" | "url" | "ref" | "documents">,
    repo: MaterializedRepo,
  ): Promise<void> {
    // Both connector ingests skip a file whose indexed document is unchanged, so a
    // re-run costs a checksum per file and resumes an ingest that was cut short.
    const t0 = performance.now();
    const read = (rel: string): string | null => {
      const abs = path.join(repo.cloneDir, rel);
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    };
    const url = new URL(p.url);
    const manifests: Record<string, string> = {};
    for (const name of ["go.mod", "pyproject.toml"]) {
      const text = read(name);
      if (text) manifests[name] = text;
    }
    const top = await fs.readdir(repo.cloneDir, { withFileTypes: true });
    const meta = await ingestRepoMetadata(repo.projectId, repo.connectorId, user.id, {
      repo: { full_name: url.pathname.slice(1), default_branch: p.ref, size: 0 },
      ref: p.ref,
      refFoundUpstream: true,
      languages: {},
      topLevel: top
        .filter((e) => e.name !== ".git")
        .map((e) => ({
          type: e.isDirectory() ? ("dir" as const) : ("file" as const),
          name: e.name,
          path: e.name,
          size: 0,
        })),
      readme: read("README.md"),
      manifests,
      headSha: repo.sha,
    });
    const source = await ingestSourceAsKnowledge(
      repo.projectId,
      repo.connectorId,
      user.id,
      repo.cloneDir,
    );
    const uploaded = await ensureUploads(
      repo.projectId,
      p.name,
      p.documents.map((d) => {
        const text = d.fromCorpus
          ? readFileSync(path.join(corpusDir, d.file), "utf8")
          : read(d.file);
        if (!text) throw new Error(`${p.name}: document ${d.file} not found`);
        return { uploadAs: d.uploadAs, text };
      }),
    );
    console.log(
      `${p.name}: ingested ${meta.documentsCreated + meta.documentsUpdated} metadata and ` +
        `${source.documentsCreated + source.documentsUpdated} source documents ` +
        `(${source.chunkCount} chunks, ${source.failures} failures) and ${uploaded} uploads ` +
        `in ${((performance.now() - t0) / 1000).toFixed(0)}s`,
    );
  }
  for (const p of fixture.products) await ensureKnowledge(p, repos.get(p.name)!);

  /**
   * #2336 — the routing pool's projects: the question set's two products, the
   * other corpus's materialized repositories (their source chunks ingested as
   * for the two products), and a documents-only project per distractor
   * document set. Keyed by the routing set's product name.
   */
  async function routingPool(rf: RoutingFixture): Promise<Map<string, PoolProject>> {
    const pool = new Map<string, PoolProject>();
    for (const p of rf.products) {
      const s = p.source;
      if (s.kind === "baqa") {
        const bp = fixture.products.find((x) => x.name === p.name)!;
        pool.set(p.name, {
          projectId: repos.get(p.name)!.projectId,
          logical: new Map(
            bp.documents.map((d) => [d.uploadAs, d.fromCorpus ? d.uploadAs : d.file] as const),
          ),
        });
      } else if (s.kind === "materialized") {
        const st = await readMaterializedState(s.corpus, layout);
        const repo = st?.repos.find((r) => r.name === s.repo);
        if (!repo) throw new Error(`run pnpm eval:materialize ${s.corpus} first`);
        await ensureKnowledge({ name: p.name, url: repo.url, ref: repo.sha, documents: [] }, repo);
        pool.set(p.name, { projectId: repo.projectId, logical: new Map() });
      } else {
        // A project an analyst made for a document set: no connector, no code graph.
        const slug = `eval-routing-${p.name}`;
        const project =
          (await prisma.project.findUnique({ where: { slug }, select: { id: true } })) ??
          (await prisma.project.create({
            data: { name: slug, slug, createdById: user.id, status: "active" },
            select: { id: true },
          }));
        const n = await ensureUploads(
          project.id,
          p.name,
          s.files.map((f) => ({
            uploadAs: f.uploadAs,
            text: readFileSync(path.join(REPO_ROOT, f.file), "utf8"),
          })),
        );
        console.log(`${p.name}: ${n} document upload(s)`);
        pool.set(p.name, { projectId: project.id, logical: new Map() });
      }
    }
    return pool;
  }

  if (routingSweep) {
    const rf = parseRoutingFixture(
      JSON.parse(readFileSync(path.join(corpusDir, "routing.json"), "utf8")) as unknown,
      fixture,
    );
    await runRoutingSweep({ rf, pool: await routingPool(rf), userId: user.id });
    await prisma.$disconnect();
    return;
  }
  if (floorSweep) {
    await runFloorSweep({ fixture, questions, repos, userId: user.id });
    await prisma.$disconnect();
    return;
  }

  // #2336 — the search-all baseline: each answerable question the routing set
  // takes, asked in a chat scoped to the first `--routing-scope` products of
  // the pool, retrieving from `--route`'s projects (`all` as chat does today,
  // `routed` the offline router's choice, `oracle` exactly the answer's).
  let routing: {
    rf: RoutingFixture;
    pool: Map<string, PoolProject>;
    size: number;
    route: "all" | "routed" | "oracle";
    taken: Map<string, RoutingQuestion>;
  } | null = null;
  if (values["routing-scope"] !== undefined) {
    const route = values.route ?? "all";
    if (route !== "all" && route !== "routed" && route !== "oracle") {
      throw new Error(`--route takes all, routed or oracle, not ${route}`);
    }
    const rf = parseRoutingFixture(
      JSON.parse(readFileSync(path.join(corpusDir, "routing.json"), "utf8")) as unknown,
      fixture,
    );
    const size = Number(values["routing-scope"]);
    if (!rf.scopeSizes.includes(size)) {
      throw new Error(`--routing-scope takes ${rf.scopeSizes.join(", ")}, not ${size}`);
    }
    const taken = new Map(rf.questions.filter((q) => q.from).map((q) => [q.from!, q] as const));
    questions = questions.filter((q) => taken.has(q.id));
    if (questions.length === 0) throw new Error("no question the routing set takes is selected");
    routing = { rf, pool: await routingPool(rf), size, route, taken };
    // Load the embedder first: a cold load runs past the federated search's
    // 3 s per-project timeout, and the first question would search nothing.
    const { resolveAclActor } = await import("../src/lib/rag/acl.js");
    await getKnowledgeService().search(
      routing.pool.get(rf.products[0].name)!.projectId,
      "warm up",
      {
        k: 1,
        actor: await resolveAclActor(user.id),
      },
    );
  } else if (values.route !== undefined) {
    throw new Error("--route needs --routing-scope");
  }
  const runArm = routing ? `${arm}-scope${routing.size}-${routing.route}` : arm;

  const provider = buildProvider({ config: loadAIConfig() });
  if (provider.offline) throw new Error("a live provider is required, not the offline stub");
  const model = provider.model;
  const judgeModel = values["judge-model"] ?? model;
  const meter = new LedgerCostMeter();
  const judgeMeter = new LedgerCostMeter();
  const answerMeter = new LedgerCostMeter();

  async function readCited(product: string, file: string): Promise<string | null> {
    const p = fixture.products.find((x) => x.name === product);
    const doc = p?.documents.find((d) => d.fromCorpus && d.uploadAs === file);
    const abs = doc
      ? path.join(corpusDir, doc.file)
      : path.join(repos.get(product)!.cloneDir, file);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  }

  const sessionFlags = loadSessionToolsFlags();
  console.log(
    `ba-qa ${arm}: ${provider.key}/${model}, judge ${judgeModel}, ${questions.length} questions, cap $${budget}`,
  );
  const sessions: Session[] = [];
  let stoppedEarly: string | null = null;
  const startedAt = new Date();
  const questionCosts: number[] = [];

  for (const [i, q] of questions.entries()) {
    stoppedEarly = budgetStop({
      budgetUsd: budget,
      spentUsd: meter.spentUsd(),
      unpricedCalls: meter.unpricedCalls(),
      questionCosts,
    });
    if (stoppedEarly) break;
    const spentBefore = meter.spentUsd();
    const t0 = performance.now();
    const scope = routing
      ? { projectId: null, degraded: null }
      : chatSessionScope(q.scope.map((name) => repos.get(name)!.projectId));
    // #2336 — a routing arm's session holds the whole scope, as chat's would;
    // only what it retrieves from narrows.
    let scopeIds: string[] | null = null;
    let searchNames: readonly string[] = [];
    // The routed arm's probe is part of its retrieval: timed from here.
    const tRag = performance.now();
    if (routing) {
      const { rf, pool, size, route, taken } = routing;
      const names = scopeOf(rf, size).map((p) => p.name);
      scopeIds = names.map((n) => pool.get(n)!.projectId);
      const rq = taken.get(q.id)!;
      searchNames =
        route === "all"
          ? names
          : route === "oracle"
            ? rq.answerIn
            : routeProjects(
                q.text,
                scopeOf(rf, size),
                (await probeEvidence(scopeOf(rf, size), pool, q.text, user.id)).evidence,
              ).chosen;
    }
    const setupStart = performance.now();
    const row = await prisma.aISession.create({
      data: {
        userId: user.id,
        projectId: scope.projectId,
        ...(scopeIds ? { scopeProjectIds: JSON.stringify(scopeIds) } : {}),
        provider: provider.key,
        model,
        title: `eval #2237 ${runArm} ${q.id}`,
      },
    });
    const session = {
      id: row.id,
      userId: user.id,
      projectId: scope.projectId,
      scopeProjectIds: row.scopeProjectIds,
      agentId: null,
      loadedSkillIds: row.loadedSkillIds,
      policy: row.policy,
    };
    const resolved = await resolveSessionTools({
      session,
      provider,
      model,
      flags: sessionFlags,
      mcp: null,
    });
    const tools = (await withoutApprovalGatedTools(resolved, session, async () => false)).runtime;
    const library = await buildLibrarySystemMessages(
      session,
      tools.mode === "native" ? NATIVE_CHAT_TOOL_NOTE : tools.schemaBlock,
      { mode: tools.skillMode, catalog: tools.skillCatalog },
      offersSearchGuidance(tools),
    );
    // #2225 — retrieval runs as the asking user, so chunk ACLs apply as in /chat.
    const tSearch = performance.now();
    const rag = routing
      ? (
          await buildMultiProjectRagContext({
            userId: user.id,
            scope: {
              kind: "projects",
              projectIds: searchNames.map((n) => routing.pool.get(n)!.projectId),
            },
            query: q.text,
          })
        ).block
      : await buildAutoRagContext(scope.projectId, [{ role: "user", content: q.text }], user.id);
    // The session and tool setup between the probe and the search is not retrieval.
    const retrievalMs = Math.round(
      (routing?.route === "routed" ? setupStart - tRag : 0) + (performance.now() - tSearch),
    );
    const turn = await prepareTurn({
      session: { id: row.id, snapshot: null },
      userText: q.text,
      prefix: [...library.stable, ...library.volatile],
      beforeUser: rag ? [{ role: "system", content: rag }] : [],
      provider: provider.key,
      model,
      summarizer: async () => {
        throw new Error("a one-question session never compacts");
      },
      config: loadChatTurnConfig(null),
      ...(tools.mode === "native" ? { nativeTools: tools.toolset.specs() } : {}),
    });

    const sessionMeter = new LedgerCostMeter();
    const metered = meterProvider(
      meterProvider(meterProvider(provider, meter), answerMeter),
      sessionMeter,
    );
    const usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
    let toolCalls = 0;
    const toolNames: string[] = [];
    const loop = await runChatToolTurn(
      metered,
      {
        messages: turn.messages,
        toolset: tools.toolset,
        native: tools.mode === "native",
        ctx: { sessionId: row.id, userId: user.id, projectId: scope.projectId },
        gate: sessionGate({ session, runtime: tools }),
      },
      {
        providerChatOptions: {
          sessionId: row.id,
          model,
          callType: "chat",
          promptCaching: chatToolLoopPromptCaching(provider),
        },
        toolResultMaxChars: turn.build.toolResultMaxChars,
        onUsage: (u) => {
          usage.promptTokens +=
            u.promptTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
          usage.completionTokens += u.completionTokens;
          usage.calls++;
        },
        onToolRecord: (record) => {
          toolCalls++;
          toolNames.push(record.tool);
        },
      },
    );

    const reply = loop.replyText;
    const { citations, ambiguous } = extractCitations(
      reply,
      q.scope.map((name) => citable.get(name)!),
    );
    const { spans, index } = await buildJudgedSpans(citations, readCited);
    const judged = await meterProvider(meterProvider(provider, meter), judgeMeter).chat(
      buildJudgeMessages(q, reply, spans),
      { model: judgeModel, disableTools: true, maxTokens: 1200, callType: "grounding" },
    );
    const verdict = parseJudgeVerdict(judged.content, q, spans);
    const score = scoreQuestion(q, citations, index, verdict);
    const costUsd = sessionMeter.unpricedCalls() > 0 ? null : sessionMeter.spentUsd();
    questionCosts.push(meter.spentUsd() - spentBefore);
    sessions.push({
      arm: runArm,
      ...(routing
        ? { searchScope: `${searchNames.length} of ${routing.size} products (${routing.route})` }
        : {}),
      retrievalMs,
      questionId: q.id,
      score,
      costUsd,
      projectId: scope.projectId,
      ragChars: rag.length,
      toolCalls,
      toolNames,
      turnsExhausted: loop.loop.turnsExhausted,
      truncatedToolResults: loop.toolResults.filter((t) => t.truncated).length,
      sessionId: row.id,
      seconds: Number(((performance.now() - t0) / 1000).toFixed(1)),
      turnsUsed: loop.turnsUsed,
      hasFinalAnswer: loop.loop.hasFinalAnswer,
      response: reply,
      ambiguousCitations: ambiguous,
      judgeReply: judged.content,
      usage,
    });
    console.log(
      `${runArm} ${q.id} [${i + 1}/${questions.length}]: ${score.behaviour ?? "UNSCORED"} ` +
        `(expect ${q.expect}), facts ${score.facts ? `${score.facts.stated}/${score.facts.total}` : "-"}, ` +
        `${citations.length} cites, ${toolCalls} tools ` +
        `(${loop.toolResults.filter((t) => t.truncated).length} cut, ` +
        `${loop.turnsUsed} turns${loop.loop.turnsExhausted ? ", OUT OF TURNS" : ""}), ` +
        `rag ${rag.length} chars, ` +
        `$${(costUsd ?? Number.NaN).toFixed(4)} — total $${meter.spentUsd().toFixed(4)}`,
    );
  }

  const answerUsd = answerMeter.unpricedCalls() > 0 ? null : answerMeter.spentUsd();
  const judgeUsd = judgeMeter.unpricedCalls() > 0 ? null : judgeMeter.spentUsd();
  const summary = summarizeArm(
    runArm,
    sessions.map((s) => s.score),
    { answerUsd, judgeUsd },
  );
  const runId = `${startedAt.toISOString().replace(/[:.]/g, "-")}-${runArm}`;
  const envelope: Envelope & Record<string, unknown> = {
    kind: "ba-qa",
    // 2 (#2265): a citation's check can be `no-such-lines`, and the summary
    // reports citation precision per check instead of one blended rate.
    version: 2,
    issue: 2237,
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    provider: provider.key,
    model,
    judgeModel,
    fixture: { id: fixture.id, version: fixture.version },
    products: fixture.products.map((p) => ({
      name: p.name,
      sha: p.sha,
      projectId: repos.get(p.name)!.projectId,
    })),
    arm: runArm,
    flags: routing ? { ...flags, routingScope: String(routing.size), route: routing.route } : flags,
    sessionToolFlags: sessionFlags,
    budgetUsd: budget,
    spentUsd: Number(meter.spentUsd().toFixed(6)),
    stoppedEarly,
    summary,
    sessions,
  };

  // An arm run by an earlier invocation, reported beside this one: same fixture,
  // answer model and judge, and an arm not already in the report.
  const all: Envelope[] = [envelope];
  for (const file of values.include ?? []) {
    const prior = JSON.parse(await fs.readFile(path.resolve(file), "utf8")) as Envelope;
    assertComparable(
      prior,
      envelope,
      all.map((e) => e.arm),
      file,
    );
    // Re-summarized from its per-question scores by this code, so both columns
    // are computed alike — a file written before a metric was added has it too.
    const { answerUsd, judgeUsd } = prior.summary.cost;
    all.push({
      ...prior,
      summary: summarizeArm(
        prior.arm,
        prior.sessions.map((s) => s.score),
        { answerUsd, judgeUsd },
      ),
    });
  }
  all.sort((a, b) => a.arm.localeCompare(b.arm));
  const markdown = formatBaQaReport({
    title: `BA question answering (#2237) — ${runId}`,
    provider: provider.key,
    model,
    judgeModel,
    arms: all.map((e) => e.summary),
    armFlags: Object.fromEntries(all.map((e) => [e.arm, e.flags])),
    sessions: all.flatMap((e) => e.sessions),
    spentUsd: all.reduce((a, e) => a + ((e as { spentUsd?: number }).spentUsd ?? 0), 0),
    stoppedEarly,
  });
  const outDir = values.out
    ? path.resolve(values.out)
    : path.join(REPO_ROOT, "eval-results", "ba-qa");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, `${runId}.json`), `${JSON.stringify(envelope, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, `${runId}.md`), `${markdown}\n`);
  console.log(`\n${markdown}`);
  console.log(`results: ${path.join(outDir, runId)}.{json,md}`);
  if (stoppedEarly) console.log(`STOPPED EARLY: ${stoppedEarly}`);
  await prisma.$disconnect();
}

/**
 * #2241 — chat's knowledge search for every question over each product in its
 * scope, and what each candidate floor would drop. No model is called.
 */
async function runFloorSweep(input: {
  fixture: Awaited<ReturnType<typeof loadBaQaFixture>>;
  questions: readonly BaQaQuestion[];
  repos: ReadonlyMap<string, MaterializedRepo>;
  userId: string;
}): Promise<void> {
  const { getKnowledgeService } = await import("../src/lib/rag/knowledge-service.js");
  const { resolveAclActor } = await import("../src/lib/rag/acl.js");
  const { denseCosine } = await import("../src/lib/ai/relevance-floor.js");
  const actor = await resolveAclActor(input.userId);
  const samples: RetrievalSample[] = [];
  for (const q of input.questions) {
    for (const name of q.scope) {
      const product = input.fixture.products.find((p) => p.name === name)!;
      // An upload is cited by the logical path its source names (`miniflux.1`).
      const logical = new Map(
        product.documents.map((d) => [d.uploadAs, d.fromCorpus ? d.uploadAs : d.file] as const),
      );
      const expected = new Set(
        (q.sources ?? []).filter((s) => s.product === name).map((s) => s.path),
      );
      const { hits } = await getKnowledgeService().search(
        input.repos.get(name)!.projectId,
        q.text,
        { k: 8, actor },
      );
      samples.push({
        questionId: q.id,
        expect: q.expect,
        product: name,
        hits: hits.map((h) => {
          const shown = h.path ?? h.filename;
          const file = logical.get(shown) ?? shown;
          return { name: file, cosine: denseCosine(h), expected: expected.has(file) };
        }),
      });
    }
  }
  // Off-topic probes: what the floor is for, searched over each product alone.
  for (const [i, text] of OFF_TOPIC_PROBES.entries()) {
    for (const p of input.fixture.products) {
      const { hits } = await getKnowledgeService().search(
        input.repos.get(p.name)!.projectId,
        text,
        { k: 8, actor },
      );
      samples.push({
        questionId: `P${i + 1}`,
        expect: "off-topic",
        product: p.name,
        hits: hits.map((h) => ({
          name: h.path ?? h.filename,
          cosine: denseCosine(h),
          expected: false,
        })),
      });
    }
  }
  const floors = Array.from({ length: 31 }, (_, i) => Number((0.45 + i * 0.01).toFixed(2)));
  const rows = sweepFloors(samples, floors);
  const best = safestFloor(rows);
  const perQuestion = samples.map((s) => {
    const cos = s.hits.map((h) => h.cosine).filter((c): c is number => c !== null);
    const top = cos.length > 0 ? Math.max(...cos).toFixed(3) : "-";
    const exp = s.hits.filter((h) => h.expected && h.cosine !== null).map((h) => h.cosine!);
    const minExp = exp.length > 0 ? Math.min(...exp).toFixed(3) : "-";
    const n = s.hits.filter((h) => h.expected).length;
    return `| ${s.questionId} | ${s.expect} | ${s.product} | ${top} | ${minExp} | ${n}/${s.hits.length} |`;
  });
  const markdown = [
    "# Relevance floor sweep (#2241)",
    "",
    formatFloorSweep(rows),
    "",
    `Highest floor that empties no answerable question and keeps every expected excerpt: ${best ?? "none"}`,
    "",
    "| Question | Expect | Product | Top cosine | Lowest expected cosine | Expected hits |",
    "|---|---|---|---:|---:|---:|",
    ...perQuestion,
  ].join("\n");
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-floor`;
  const outDir = path.join(REPO_ROOT, "eval-results", "ba-qa");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, `${runId}.json`),
    `${JSON.stringify({ kind: "ba-qa-floor", issue: 2241, samples, rows, best }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(outDir, `${runId}.md`), `${markdown}\n`);
  console.log(markdown);
}

/**
 * #2336 — the router's probe: each project's own knowledge search for `text`,
 * as the asking user, of which only keyword-backed hits count as evidence.
 */
async function probeEvidence(
  scope: readonly { name: string }[],
  pool: ReadonlyMap<string, PoolProject>,
  text: string,
  userId: string,
): Promise<{ evidence: Map<string, ProbeEvidence>; hits: ProbeHit[] }> {
  const { getKnowledgeService } = await import("../src/lib/rag/knowledge-service.js");
  const { resolveAclActor } = await import("../src/lib/rag/acl.js");
  const actor = await resolveAclActor(userId);
  const all: ProbeHit[][] = [];
  const evidence = new Map(
    await Promise.all(
      scope.map(async (p, i) => {
        const { hits } = await getKnowledgeService().search(pool.get(p.name)!.projectId, text, {
          k: DEFAULT_ROUTING_OPTIONS.probeK,
          actor,
        });
        const logical = pool.get(p.name)!.logical;
        all[i] = hits.map((h) => {
          const shown = h.path ?? h.filename;
          return {
            product: p.name,
            key: `${p.name}:${logical.get(shown) ?? shown}`,
            cosine: h.denseScore ?? (h.matchedBy?.includes("dense") ? h.score : null),
            chars: h.text.length,
          };
        });
        return [p.name, evidenceFromHits(text, hits)] as const;
      }),
    ),
  );
  return { evidence, hits: all.flat() };
}

/**
 * #2336 Part A — route every routing question over each scope size with the
 * offline router, and run what search-all, the router's choice and an oracle
 * (exactly the answer's products) put in the prompt: the real federated search
 * and the real multi-product block. No model is called.
 */
async function runRoutingSweep(input: {
  rf: RoutingFixture;
  pool: ReadonlyMap<string, PoolProject>;
  userId: string;
}): Promise<void> {
  const { rf, pool, userId } = input;
  const { getKnowledgeService } = await import("../src/lib/rag/knowledge-service.js");
  const { getFederatedSearchService } = await import("../src/lib/rag/federated-search-service.js");
  const { resolveAclActor } = await import("../src/lib/rag/acl.js");
  const { buildMultiProjectRagContext, MULTI_PROJECT_K } =
    await import("../src/lib/ai/multi-project-rag.js");
  type Federated = Awaited<
    ReturnType<ReturnType<typeof getFederatedSearchService>["searchAcrossProjects"]>
  >;
  const ks = getKnowledgeService();
  const fed = getFederatedSearchService();
  const actor = await resolveAclActor(userId);
  const opts = DEFAULT_ROUTING_OPTIONS;
  const nameOf = new Map([...pool].map(([name, p]) => [p.projectId, name] as const));
  const idOf = (name: string) => pool.get(name)!.projectId;

  /** The prompt block and the search behind it, timed: the search alone. */
  async function retrieve(names: readonly string[], query: string) {
    let ms = 0;
    const box: { result: Federated | null } = { result: null };
    const { block } = await buildMultiProjectRagContext({
      userId,
      scope: { kind: "projects", projectIds: names.map(idOf) },
      query,
      deps: {
        search: async (o) => {
          const t = performance.now();
          box.result = await fed.searchAcrossProjects(o);
          ms = performance.now() - t;
          return box.result;
        },
      },
    });
    const r = box.result;
    if (!r) throw new Error(`no search ran for ${names.join(", ")}`);
    const hits = r.hits.map((h) => {
      const name = nameOf.get(h.projectId) ?? h.projectId;
      const shown = h.path ?? h.filename;
      return `${name}:${pool.get(name)?.logical.get(shown) ?? shown}`;
    });
    return { ms, block, hits, searched: r.projectsSearched.length, failed: r.failures.length };
  }

  // Load the embedder before anything is timed.
  await ks.search(idOf(rf.products[0].name), "warm up", { k: 1, actor });

  const samples: RoutingSample[] = [];
  const runs: RetrievalRun[] = [];
  const probeMs: { questionId: string; scopeSize: number; ms: number }[] = [];
  for (const size of rf.scopeSizes) {
    const scope = scopeOf(rf, size);
    for (const q of rf.questions) {
      if (!answerableIn(q, scope)) continue;
      const t0 = performance.now();
      const { evidence, hits: probeHits } = await probeEvidence(scope, pool, q.text, userId);
      const probe = performance.now() - t0;
      probeMs.push({ questionId: q.id, scopeSize: size, ms: Math.round(probe) });
      const decision = routeProjects(q.text, scope, evidence, opts);
      samples.push({ questionId: q.id, scopeSize: size, answerIn: q.answerIn, decision });
      if (q.answerIn.length === 0) continue;
      const modes = [
        ["all", scope.map((p) => p.name)],
        ["routed", decision.chosen],
        ["oracle", q.answerIn],
      ] as const;
      const ranked = rankAcrossProjects(probeHits, MULTI_PROJECT_K);
      runs.push({
        questionId: q.id,
        scopeSize: size,
        mode: "ranked",
        answerIn: q.answerIn,
        expectedFiles: q.expectedFiles,
        projectsSearched: scope.length,
        failed: 0,
        hits: ranked.map((h) => h.key),
        ms: Math.round(probe),
        blockChars: ranked.reduce((a, h) => a + h.chars, 0),
      });
      for (const [mode, names] of modes) {
        const r = await retrieve(names, q.text);
        runs.push({
          questionId: q.id,
          scopeSize: size,
          mode,
          answerIn: q.answerIn,
          expectedFiles: q.expectedFiles,
          projectsSearched: r.searched,
          failed: r.failed,
          hits: r.hits,
          ms: Math.round(r.ms + (mode === "routed" ? probe : 0)),
          blockChars: r.block.length,
        });
      }
      console.log(
        `${size} ${q.id}: ${decision.route}${decision.reason ? ` (${decision.reason})` : ""}, ` +
          `${decision.chosen.length}/${scope.length} chosen, probe ${Math.round(probe)} ms`,
      );
    }
  }
  const routing = summarizeRouting(samples);
  const retrieval = summarizeRetrieval(runs);
  const markdown = formatRoutingReport({ routing, retrieval, samples, options: opts });
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-routing`;
  const outDir = path.join(REPO_ROOT, "eval-results", "ba-qa");
  await fs.mkdir(outDir, { recursive: true });
  const envelope = {
    kind: "ba-qa-routing",
    issue: 2336,
    fixture: { id: rf.id, version: rf.version },
    options: opts,
    routing,
    retrieval,
    samples,
    runs,
    probeMs,
  };
  await fs.writeFile(path.join(outDir, `${runId}.json`), `${JSON.stringify(envelope, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, `${runId}.md`), `${markdown}\n`);
  console.log(markdown);
  console.log(`results: ${path.join(outDir, runId)}.{json,md}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("eval:ba-qa failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
