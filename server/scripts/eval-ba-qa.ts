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
 * Arms: `off` unsets `CHAT_CODE_SEARCH_TOOLS`, `CHAT_FUSED_CODE_RETRIEVAL` and
 * `RAG_RERANK`, whatever the shell or `.env` set; `on` sets all three.
 *
 * Each answer is graded by one judge call (`judge.ts`); every rate is computed
 * from its verdicts in code (`metrics.ts`). Spend is ledger-priced, answers and
 * judge apart, and held under `--budget` (USD): the run stops before a question
 * once the cap is reached, or on an unpriced call.
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
  applyArmEnv,
  buildJudgedSpans,
  chatSessionScope,
  parseArm,
} from "../src/lib/eval/ba-qa/run.js";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(SERVER_DIR, "..");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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
    },
  });
  const floorSweep = values["floor-sweep"] === true;
  if (!values.arm && !floorSweep) throw new Error("--arm off|on is required");
  // #2241 — the sweep measures the default search: the flags off.
  const arm = floorSweep ? "off" : parseArm(values.arm!);
  const budget = Number(values.budget);
  if (!floorSweep && (!values.budget || !Number.isFinite(budget) || budget <= 0)) {
    throw new Error("--budget <usd> is required: the run's hard spend cap");
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
  const { resolveSessionTools, loadSessionToolsFlags, sessionGate, withoutApprovalGatedTools } =
    await import("../src/lib/ai/tool-runtime/session-tools.js");
  const { runChatToolTurn } = await import("../src/lib/ai/tool-runtime/chat-turn.js");
  const { prepareTurn, loadChatTurnConfig } = await import("../src/lib/ai/conversation/turn.js");
  const { chatToolLoopPromptCaching } = await import("../src/lib/ai/chat-prompt-caching.js");
  const { buildAutoRagContext, buildLibrarySystemMessages, NATIVE_CHAT_TOOL_NOTE } =
    await import("../src/routes/ai.js");
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

  /** What an analyst's project holds besides the code graph: documents and source chunks. */
  async function ensureKnowledge(p: BaQaProduct, repo: MaterializedRepo): Promise<void> {
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
    const storage = getDocumentStorage();
    let uploaded = 0;
    for (const d of p.documents) {
      const text = d.fromCorpus ? readFileSync(path.join(corpusDir, d.file), "utf8") : read(d.file);
      if (!text) throw new Error(`${p.name}: document ${d.file} not found`);
      const checksum = crypto.createHash("sha256").update(text).digest("hex");
      const existing = await prisma.document.findMany({
        where: { projectId: repo.projectId, filename: d.uploadAs, deletedAt: null },
        select: { id: true, checksum: true, indexState: true },
      });
      if (existing.some((e) => e.checksum === checksum && e.indexState === "indexed")) continue;
      // A stale or half-ingested copy is replaced, never left beside the new one. It
      // goes BEFORE the write: a delete removes the content-addressed blob, which
      // the new copy of the same text would share.
      for (const e of existing) await getKnowledgeService().deleteDocument(e.id);
      const stored = await storage.write({ projectId: repo.projectId, buffer: Buffer.from(text) });
      const doc = await prisma.document.create({
        data: {
          projectId: repo.projectId,
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
        throw new Error(`${p.name}: ${d.uploadAs} ended ${settled.status}/${settled.indexState}`);
      }
      uploaded++;
    }
    console.log(
      `${p.name}: ingested ${meta.documentsCreated + meta.documentsUpdated} metadata and ` +
        `${source.documentsCreated + source.documentsUpdated} source documents ` +
        `(${source.chunkCount} chunks, ${source.failures} failures) and ${uploaded} uploads ` +
        `in ${((performance.now() - t0) / 1000).toFixed(0)}s`,
    );
  }
  for (const p of fixture.products) await ensureKnowledge(p, repos.get(p.name)!);

  if (floorSweep) {
    await runFloorSweep({ fixture, questions, repos, userId: user.id });
    await prisma.$disconnect();
    return;
  }

  const provider = buildProvider({ config: loadAIConfig() });
  if (provider.offline) throw new Error("a live provider is required, not the offline stub");
  const model = provider.model;
  const judgeModel = values["judge-model"] ?? model;
  const meter = new LedgerCostMeter();
  const judgeMeter = new LedgerCostMeter();
  const answerMeter = new LedgerCostMeter();

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

  for (const [i, q] of questions.entries()) {
    if (meter.unpricedCalls() > 0) {
      stoppedEarly = "an unpriced call: the cap cannot be enforced";
      break;
    }
    if (meter.spentUsd() >= budget) {
      stoppedEarly = `the $${budget} cap was reached`;
      break;
    }
    const t0 = performance.now();
    const scope = chatSessionScope(q.scope.map((name) => repos.get(name)!.projectId));
    const row = await prisma.aISession.create({
      data: {
        userId: user.id,
        projectId: scope.projectId,
        provider: provider.key,
        model,
        title: `eval #2237 ${arm} ${q.id}`,
      },
    });
    const session = {
      id: row.id,
      userId: user.id,
      projectId: scope.projectId,
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
    );
    // #2225 — retrieval runs as the asking user, so chunk ACLs apply as in /chat.
    const rag = await buildAutoRagContext(
      scope.projectId,
      [{ role: "user", content: q.text }],
      user.id,
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
        onToolRecord: () => {
          toolCalls++;
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
    sessions.push({
      arm,
      questionId: q.id,
      score,
      costUsd,
      projectId: scope.projectId,
      ragChars: rag.length,
      toolCalls,
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
      `${arm} ${q.id} [${i + 1}/${questions.length}]: ${score.behaviour ?? "UNSCORED"} ` +
        `(expect ${q.expect}), facts ${score.facts ? `${score.facts.stated}/${score.facts.total}` : "-"}, ` +
        `${citations.length} cites, ${toolCalls} tools, rag ${rag.length} chars, ` +
        `$${(costUsd ?? Number.NaN).toFixed(4)} — total $${meter.spentUsd().toFixed(4)}`,
    );
  }

  const answerUsd = answerMeter.unpricedCalls() > 0 ? null : answerMeter.spentUsd();
  const judgeUsd = judgeMeter.unpricedCalls() > 0 ? null : judgeMeter.spentUsd();
  const summary = summarizeArm(
    arm,
    sessions.map((s) => s.score),
    { answerUsd, judgeUsd },
  );
  const runId = `${startedAt.toISOString().replace(/[:.]/g, "-")}-${arm}`;
  const envelope: Envelope & Record<string, unknown> = {
    kind: "ba-qa",
    version: 1,
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
    arm,
    flags,
    sessionToolFlags: sessionFlags,
    budgetUsd: budget,
    spentUsd: Number(meter.spentUsd().toFixed(6)),
    stoppedEarly,
    summary,
    sessions,
  };

  // An arm run by an earlier invocation, reported beside this one.
  const all: Envelope[] = [envelope];
  for (const file of values.include ?? []) {
    const prior = JSON.parse(await fs.readFile(path.resolve(file), "utf8")) as Envelope;
    if (prior.kind !== "ba-qa" || prior.fixture.id !== fixture.id || prior.model !== model) {
      throw new Error(`${file} is another fixture or model: not comparable`);
    }
    if (prior.fixture.version !== fixture.version) {
      throw new Error(
        `${file} scored fixture version ${prior.fixture.version}, not ${fixture.version}`,
      );
    }
    all.push(prior);
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

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("eval:ba-qa failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
