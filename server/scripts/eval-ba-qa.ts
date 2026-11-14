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
 * #2412 — `tools-context` is `tools-only` plus `CHAT_CODE_CONTEXT_TOOL`
 * (`search_code_context`). Every named arm sets that flag itself: on in `on`
 * and the `no-*` arms, off in `off`, `tools-only` and `tools-primitives`.
 *
 * Arms (#2243): `off` sets `CHAT_CODE_SEARCH_TOOLS`, `CHAT_FUSED_CODE_RETRIEVAL`
 * and `RAG_RERANK` off and `on` sets all three, whatever the shell or `.env` set;
 * `no-tools`, `no-fused` and `no-rerank` take one flag away from `on`; `default`
 * unsets all three, so each reads the server's default.
 *
 * #2269 — `--multi-turn` asks the multi-turn set instead: each question's
 * earlier turns (`before`) are asked and answered live in the same session,
 * recorded in its transcript as the chat routes record them (with the excerpts
 * each answer cited), and only the last turn is graded. `--retrieval` picks how
 * a turn's auto-RAG reads the chat: `conversation` (production, #2240) or
 * `last-message` (the new message alone, as before #2240); the report labels
 * the arm `<arm>+last-message` for the latter. Whatever the mode, the graded
 * turn is also searched the other way, locally, so every run reports how many
 * expected files each mode's excerpts held:
 *
 *   pnpm eval:ba-qa --arm off --budget 2 --multi-turn
 *   pnpm eval:ba-qa --arm off --budget 2 --multi-turn --retrieval last-message --include <off>.json
 *
 * Each answer is graded by one judge call (`judge.ts`); every rate is computed
 * from its verdicts in code (`metrics.ts`). Spend is ledger-priced, answers and
 * judge apart, and held under `--budget` (USD): the run stops before a question
 * once the cap is reached, once the costliest question so far would carry the
 * spend past it, or on an unpriced call (`budgetStop`). #2316 — it is checked
 * within a question too, before each later turn of a multi-turn question and
 * before the judge, against the costliest turn or judge call so far (kept
 * apart, so a cheap judge is not held to an answer's cost); a question cut
 * short is not graded. One step costlier than any before it can still cross it.
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
  expectedSourceFiles,
  isMultiTurn,
  loadBaQaFixture,
  type BaQaProduct,
  type BaQaQuestion,
} from "../src/lib/eval/ba-qa/fixture.js";
import { extractCitations, type CitableProduct } from "../src/lib/eval/ba-qa/citations.js";
import { buildJudgeMessages, parseJudgeVerdict } from "../src/lib/eval/ba-qa/judge.js";
import {
  scoreQuestion,
  summarizeArm,
  // #2269's per-turn retrieval summary; routing.js has its own `summarizeRetrieval`.
  summarizeRetrieval as summarizeTurnRetrieval,
  type ArmSummary,
  type RetrievalSummary,
  type TurnRetrieval,
} from "../src/lib/eval/ba-qa/metrics.js";
import {
  formatFloorSweep,
  OFF_TOPIC_PROBES,
  safestFloor,
  sweepFloors,
  type RetrievalSample,
} from "../src/lib/eval/ba-qa/relevance-floor.js";
import { formatBaQaReport, type ReportSession } from "../src/lib/eval/ba-qa/report.js";
import type { ReplyToolCall } from "../src/lib/ai/conversation/turn.js";
import type { RagContextCapture } from "../src/routes/ai.js";
import {
  indexFaultState,
  parseIndexFault,
  summarizeIndexFault,
} from "../src/lib/eval/ba-qa/index-fault.js";
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
  armLabel,
  assertComparable,
  assertRoutingFlags,
  BA_QA_RESULTS_VERSION,
  budgetStop,
  buildJudgedSpans,
  chatSessionScope,
  parseArm,
  parseRetrievalMode,
  retrievedExpectedFiles,
  selectQuestions,
  stepBudgetStop,
  type StepCosts,
  type StepKind,
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
  /** The whole question, the judge's call included; the report reads `answerSeconds`. */
  seconds: number;
  answerSeconds: number;
  turnsUsed: number;
  hasFinalAnswer: boolean;
  response: string;
  ambiguousCitations: string[];
  judgeReply: string;
  usage: { promptTokens: number; completionTokens: number; calls: number };
  /** #2269 — a multi-turn question's earlier replies, and its graded turn searched both ways. */
  earlierReplies?: string[];
  retrieval?: TurnRetrieval;
}

interface Envelope {
  kind: "ba-qa";
  /**
   * The results-file format (`BA_QA_RESULTS_VERSION`); absent before #2265.
   * `--include` reads it to refuse a version 1 file (#2363).
   */
  version?: number;
  runId: string;
  provider: string;
  model: string;
  judgeModel: string;
  fixture: { id: string; version: number };
  arm: string;
  flags: Record<string, string>;
  summary: ArmSummary;
  /** #2269 — present on a run that asked multi-turn questions. */
  retrieval?: RetrievalSummary;
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
      "multi-turn": { type: "boolean" },
      retrieval: { type: "string" },
      "floor-sweep": { type: "boolean" },
      // #2326 — record each product's last indexing run as failed or partial.
      "index-fault": { type: "string" },
      "routing-sweep": { type: "boolean" },
      "routing-scope": { type: "string" },
      route: { type: "string" },
    },
  });
  // #2336 — the routing sweep, like the floor sweep, asks no model.
  const routingSweep = values["routing-sweep"] === true;
  assertRoutingFlags({
    routingSweep,
    floorSweep: values["floor-sweep"] === true,
    routingScope: values["routing-scope"],
    route: values.route,
  });
  const floorSweep = values["floor-sweep"] === true || routingSweep;
  if (!values.arm && !floorSweep) {
    throw new Error("--arm is required (default, off, on, no-tools, …)");
  }
  // #2241 — the sweep measures the search with the flags off.
  const flagArm = floorSweep ? parseArm("off") : parseArm(values.arm!);
  const retrievalMode = parseRetrievalMode(values.retrieval ?? "conversation");
  const arm = armLabel(flagArm, retrievalMode);
  const budget = Number(values.budget);
  if (!floorSweep && (!values.budget || !Number.isFinite(budget) || budget <= 0)) {
    throw new Error("--budget <usd> is required: the run's spend cap");
  }
  // Before any module reads a flag.
  const flags = applyArmEnv(process.env, flagArm);

  const corpusDir = baQaCorpusDir(REPO_ROOT, BAQA_CORPUS);
  const fixture = await loadBaQaFixture(corpusDir);
  let questions = selectQuestions(fixture.questions, {
    multiTurn: values["multi-turn"] ?? false,
    ...(values.questions ? { ids: values.questions.split(",").map((s) => s.trim()) } : {}),
    ...(values.limit ? { limit: Number(values.limit) } : {}),
  });
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
  const { prepareTurn, loadChatTurnConfig, recordReply } =
    await import("../src/lib/ai/conversation/turn.js");
  const { chatToolLoopPromptCaching } = await import("../src/lib/ai/chat-prompt-caching.js");
  const {
    buildAutoRagContext,
    buildLibrarySystemMessages,
    conversationRagContext,
    NATIVE_CHAT_TOOL_NOTE,
  } = await import("../src/routes/ai.js");
  const { citedExcerptsMeta, planRetrievalQueries, retrievalConversation } =
    await import("../src/lib/ai/conversation/retrieval-query.js");
  const { listActiveMessages } = await import("../src/lib/ai/conversation/transcript-store.js");
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

  // #2338 — an arm that offers get_change_history reads each product's commit
  // history: fetched at the materialized commit, as an ingest fetches it at the
  // indexed one, and kept while it stays at that commit.
  if (flags.CHAT_CHANGE_HISTORY_TOOL === "1") {
    const history = await import("../src/lib/connectors/repo/history-repo.js");
    const { resolveRepoCloneMaxBytes } = await import("../src/lib/connectors/repo/repo-service.js");
    const env: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"]) {
      if (process.env[k] !== undefined) env[k] = process.env[k]!;
    }
    for (const p of fixture.products) {
      const repo = repos.get(p.name)!;
      const st = await history.readHistoryState(repo.connectorId);
      if (st?.status === "ready" && st.commitSha === p.sha) continue;
      const out = await history.fetchHistoryRepository({
        connectorId: repo.connectorId,
        remoteUrl: p.url,
        commitSha: p.sha,
        env,
        windowDays: history.resolveHistoryWindowDays(),
        maxBytes: history.resolveRepoHistoryMaxBytes(resolveRepoCloneMaxBytes()),
      });
      if (out.status !== "ready") throw new Error(`${p.name}: commit history ${out.status}`);
      console.log(`${p.name}: commit history since ${out.windowStart.slice(0, 10)} fetched`);
    }
  }

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
  // #2326 — the fault is written for this run only, and restored after it.
  const indexFault = values["index-fault"] ? parseIndexFault(values["index-fault"]) : null;
  const savedIngestStates = new Map<string, string | null>();
  /** Put back every state the fault replaced; each once, whatever ends the run. */
  const restoreIngestStates = async (): Promise<void> => {
    for (const [id, saved] of [...savedIngestStates]) {
      savedIngestStates.delete(id);
      await prisma.repoConnection.update({ where: { id }, data: { sourceIngestState: saved } });
    }
  };
  // An interrupted run (Ctrl-C) must not leave the products' index faulted.
  const onSignal = (signal: NodeJS.Signals) => {
    void restoreIngestStates().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  if (indexFault) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  console.log(
    `ba-qa ${arm}: ${provider.key}/${model}, judge ${judgeModel}, ${questions.length} questions, cap $${budget}`,
  );
  const sessions: Session[] = [];
  let stoppedEarly: string | null = null;
  const startedAt = new Date();
  const questionCosts: number[] = [];
  // #2316 — what each step of a question cost, turns and judge calls apart,
  // for the check before the next step of the same kind.
  const stepCosts: StepCosts = { turn: [], judge: [] };
  const stepStop = (next: StepKind) =>
    stepBudgetStop({
      budgetUsd: budget,
      spentUsd: meter.spentUsd(),
      unpricedCalls: meter.unpricedCalls(),
      stepCosts,
      next,
    });

  try {
    if (indexFault) {
      const faulted = JSON.stringify(indexFaultState(indexFault, new Date()));
      for (const repo of repos.values()) {
        const row = await prisma.repoConnection.findUniqueOrThrow({
          where: { id: repo.connectorId },
          select: { sourceIngestState: true },
        });
        // Saved before the write, so a write that fails part-way is still undone.
        savedIngestStates.set(repo.connectorId, row.sourceIngestState);
        await prisma.repoConnection.update({
          where: { id: repo.connectorId },
          data: { sourceIngestState: faulted },
        });
      }
      console.log(`index fault: every product's last indexing run is recorded as ${indexFault}`);
    }
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
      const sessionMeter = new LedgerCostMeter();
      const metered = meterProvider(
        meterProvider(meterProvider(provider, meter), answerMeter),
        sessionMeter,
      );
      const usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
      let toolCalls = 0;
      const toolNames: string[] = [];
      // #2269 — a multi-turn question's earlier turns are asked first, in the same
      // session; only the last turn is graded.
      const multiTurn = isMultiTurn(q);
      const turns = [...(q.before ?? []), q.text];
      const earlierReplies: string[] = [];
      let retrieval: TurnRetrieval | undefined;
      let rag = "";
      let reply = "";
      // #2336 — the graded turn's retrieval time, a routed arm's probe included.
      let retrievalMs = 0;
      let loop: Awaited<ReturnType<typeof runChatToolTurn>> | null = null;
      for (const [t, userText] of turns.entries()) {
        // #2316 — the cap is checked before every turn after the first (the
        // question's own check covered that one), not only between questions.
        if (t > 0) {
          stoppedEarly = stepStop("turn");
          if (stoppedEarly) break;
        }
        const stepBefore = meter.spentUsd();
        const graded = t === turns.length - 1;
        const viaConversation = retrievalMode === "conversation";
        // The graded turn of a multi-turn question is searched both ways; only
        // the run's own mode reaches the model.
        const both = graded && multiTurn;
        // #2225 — retrieval runs as the asking user, so chunk ACLs apply as in /chat.
        const conv: RagContextCapture = { contexts: [], sources: 0 };
        const last: RagContextCapture = { contexts: [], sources: 0 };
        let searchMs = 0;
        if (routing) {
          // #2336 — a routing arm retrieves from the projects its route chose.
          const tSearch = performance.now();
          rag = (
            await buildMultiProjectRagContext({
              userId: user.id,
              scope: {
                kind: "projects",
                projectIds: searchNames.map((n) => routing.pool.get(n)!.projectId),
              },
              query: userText,
            })
          ).block;
          searchMs = performance.now() - tSearch;
        } else {
          let convRag = "";
          if (viaConversation || both) {
            const tSearch = performance.now();
            convRag = await conversationRagContext(
              { id: row.id, projectId: scope.projectId },
              userText,
              user.id,
              conv,
            );
            if (viaConversation) searchMs = performance.now() - tSearch;
          }
          let lastRag = "";
          if (!viaConversation || both) {
            const tSearch = performance.now();
            lastRag = await buildAutoRagContext(
              scope.projectId,
              [{ role: "user", content: userText }],
              user.id,
              undefined,
              last,
            );
            if (!viaConversation) searchMs = performance.now() - tSearch;
          }
          rag = viaConversation ? convRag : lastRag;
        }
        // The session and tool setup between the probe and the search is not retrieval.
        if (graded) {
          retrievalMs = Math.round(
            (routing?.route === "routed" ? setupStart - tRag : 0) + searchMs,
          );
        }
        const capture = viaConversation ? conv : last;
        if (both) {
          const expected = expectedSourceFiles(q);
          const product = citable.get(q.scope[0]!)!;
          const names = (c: RagContextCapture): string[] => (c.excerpts ?? []).map((e) => e.name);
          // Read before this turn's user row is appended, as the route reads it.
          const history = retrievalConversation(await listActiveMessages(row.id)).messages;
          retrieval = {
            questionId: q.id,
            refersBack: q.refersBack ?? false,
            followUpDetected:
              (planRetrievalQueries([...history, { role: "user", content: userText }])
                ?.contextual ?? null) !== null,
            expected,
            conversation: retrievedExpectedFiles(expected, product, names(conv)),
            lastMessage: retrievedExpectedFiles(expected, product, names(last)),
            carried: conv.contexts.filter((c) => c.includes("(cited in your previous answer)"))
              .length,
          };
        }
        const turn = await prepareTurn({
          session: { id: row.id, snapshot: null },
          userText,
          prefix: [...library.stable, ...library.volatile],
          beforeUser: rag ? [{ role: "system", content: rag }] : [],
          provider: provider.key,
          model,
          summarizer: async () => {
            throw new Error("an eval session of a few turns never compacts");
          },
          config: loadChatTurnConfig(null),
          ...(tools.mode === "native" ? { nativeTools: tools.toolset.specs() } : {}),
        });

        const records: ReplyToolCall[] = [];
        loop = await runChatToolTurn(
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
            onToolRecord: (rec) => {
              toolCalls++;
              toolNames.push(rec.tool);
              records.push({
                callId: rec.callId,
                tool: rec.tool,
                args: rec.args,
                result: rec.result,
                ...(rec.isError ? { isError: true } : {}),
                executed: rec.executed,
              });
            },
          },
        );
        reply = loop.replyText;
        if (!graded) earlierReplies.push(reply);
        // Recorded as the chat routes record a reply, with the excerpts it cited,
        // so the next turn reads this one and carries those excerpts forward.
        await recordReply({
          sessionId: row.id,
          text: reply,
          toolCalls: records,
          usage: loop.usage,
          provider: provider.key,
          model,
          promptChars: null,
          ratio: turn.ratio,
          meta: citedExcerptsMeta(reply, capture.excerpts),
        });
        stepCosts.turn.push(meter.spentUsd() - stepBefore);
      }
      // A question cut short by the cap is not graded or reported.
      if (stoppedEarly) break;
      if (!loop) throw new Error(`${q.id} has no turn to ask`);
      // #2397 — the answer is done: what follows (citations, the judge) is grading.
      const answerSeconds = Number(((performance.now() - t0) / 1000).toFixed(1));
      const { citations, ambiguous } = extractCitations(
        reply,
        q.scope.map((name) => citable.get(name)!),
      );
      const { spans, index } = await buildJudgedSpans(citations, readCited);
      // #2316 — the judge is a step too, checked against the costliest judge call.
      stoppedEarly = stepStop("judge");
      if (stoppedEarly) break;
      const judgeBefore = meter.spentUsd();
      const judged = await meterProvider(meterProvider(provider, meter), judgeMeter).chat(
        buildJudgeMessages(q, reply, spans),
        { model: judgeModel, disableTools: true, maxTokens: 1200, callType: "grounding" },
      );
      stepCosts.judge.push(meter.spentUsd() - judgeBefore);
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
        answerSeconds,
        turnsUsed: loop.turnsUsed,
        hasFinalAnswer: loop.loop.hasFinalAnswer,
        response: reply,
        ambiguousCitations: ambiguous,
        judgeReply: judged.content,
        usage,
        ...(multiTurn ? { earlierReplies } : {}),
        ...(retrieval ? { retrieval } : {}),
      });
      const found = retrieval
        ? `, expected files retrieved conv ${retrieval.conversation.length} / last ` +
          `${retrieval.lastMessage.length} of ${retrieval.expected.length}` +
          `${retrieval.followUpDetected ? " (follow-up)" : ""}`
        : "";
      console.log(
        `${runArm} ${q.id} [${i + 1}/${questions.length}]: ${score.behaviour ?? "UNSCORED"} ` +
          `(expect ${q.expect}), facts ${score.facts ? `${score.facts.stated}/${score.facts.total}` : "-"}, ` +
          `${citations.length} cites, ${toolCalls} tools ` +
          `(${loop.toolResults.filter((t) => t.truncated).length} cut, ` +
          `${loop.turnsUsed} turns${loop.loop.turnsExhausted ? ", OUT OF TURNS" : ""}), ` +
          `rag ${rag.length} chars${found}, ` +
          `$${(costUsd ?? Number.NaN).toFixed(4)} — total $${meter.spentUsd().toFixed(4)}`,
      );
    }
  } finally {
    await restoreIngestStates();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  const retrievalTurns = sessions.flatMap((s) => (s.retrieval ? [s.retrieval] : []));
  const faultSummary = indexFault
    ? summarizeIndexFault(
        indexFault,
        sessions.map((s) => ({ response: s.response, behaviour: s.score.behaviour ?? null })),
      )
    : null;
  if (faultSummary) {
    console.log(
      `index fault ${faultSummary.fault}: ${faultSummary.mentioned}/${faultSummary.of} answers name ` +
        `the index problem; ${faultSummary.abstainedWithoutIndex} of ${faultSummary.abstained} ` +
        `abstentions assert absence without it`,
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
    version: BA_QA_RESULTS_VERSION,
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
    retrievalMode,
    flags: routing ? { ...flags, routingScope: String(routing.size), route: routing.route } : flags,
    sessionToolFlags: sessionFlags,
    ...(faultSummary ? { indexFault: faultSummary } : {}),
    budgetUsd: budget,
    spentUsd: Number(meter.spentUsd().toFixed(6)),
    stoppedEarly,
    summary,
    ...(retrievalTurns.length > 0 ? { retrieval: summarizeTurnRetrieval(retrievalTurns) } : {}),
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
    retrieval: Object.fromEntries(
      all.flatMap((e) => (e.retrieval ? [[e.arm, e.retrieval] as const] : [])),
    ),
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
