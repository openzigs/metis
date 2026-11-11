/**
 * #2237 — `pnpm eval:ba-qa`: measure how chat answers a business analyst's
 * questions (Phase 0 of #2228), before any default changes.
 *
 *   pnpm eval:materialize baqa-01-acme-reader            # once: clones, projects, code graph
 *   pnpm eval:ba-qa --arm off --budget 5                  # today's chat, flags off
 *   pnpm eval:ba-qa --arm on --budget 5 --include <off>.json   # flags on, reported beside off
 *   pnpm eval:ba-qa --arm off --budget 1 --questions S1,A1     # a smoke run
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
 * once the cap is reached, or on an unpriced call.
 * Results: `eval-results/ba-qa/<runId>.{json,md}`.
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
} from "../src/lib/eval/ba-qa/fixture.js";
import { extractCitations, type CitableProduct } from "../src/lib/eval/ba-qa/citations.js";
import { buildJudgeMessages, parseJudgeVerdict } from "../src/lib/eval/ba-qa/judge.js";
import {
  scoreQuestion,
  summarizeArm,
  summarizeRetrieval,
  type ArmSummary,
  type RetrievalSummary,
  type TurnRetrieval,
} from "../src/lib/eval/ba-qa/metrics.js";
import { formatBaQaReport, type ReportSession } from "../src/lib/eval/ba-qa/report.js";
import type { ReplyToolCall } from "../src/lib/ai/conversation/turn.js";
import type { RagContextCapture } from "../src/routes/ai.js";
import {
  applyArmEnv,
  armLabel,
  buildJudgedSpans,
  chatSessionScope,
  parseArm,
  parseRetrievalMode,
  retrievedExpectedFiles,
  selectQuestions,
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
  /** #2269 — a multi-turn question's earlier replies, and its graded turn searched both ways. */
  earlierReplies?: string[];
  retrieval?: TurnRetrieval;
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
    },
  });
  if (!values.arm) throw new Error("--arm off|on is required");
  const flagArm = parseArm(values.arm);
  const retrievalMode = parseRetrievalMode(values.retrieval ?? "conversation");
  const arm = armLabel(flagArm, retrievalMode);
  const budget = Number(values.budget);
  if (!values.budget || !Number.isFinite(budget) || budget <= 0) {
    throw new Error("--budget <usd> is required: the run's hard spend cap");
  }
  // Before any module reads a flag.
  const flags = applyArmEnv(process.env, flagArm);

  const corpusDir = baQaCorpusDir(REPO_ROOT, BAQA_CORPUS);
  const fixture = await loadBaQaFixture(corpusDir);
  const questions = selectQuestions(fixture.questions, {
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
  const { ingestRepoMetadata, ingestSourceAsKnowledge } =
    await import("../src/lib/connectors/connector-ingest.js");
  const { getDocumentStorage } = await import("../src/lib/documents/storage.js");
  const { getKnowledgeService } = await import("../src/lib/rag/knowledge-service.js");
  const { approveDocument } = await import("../src/lib/rag/quarantine.js");

  const provider = buildProvider({ config: loadAIConfig() });
  if (provider.offline) throw new Error("a live provider is required, not the offline stub");
  const model = provider.model;
  const judgeModel = values["judge-model"] ?? model;
  const meter = new LedgerCostMeter();
  const judgeMeter = new LedgerCostMeter();
  const answerMeter = new LedgerCostMeter();

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
    const sessionMeter = new LedgerCostMeter();
    const metered = meterProvider(
      meterProvider(meterProvider(provider, meter), answerMeter),
      sessionMeter,
    );
    const usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
    let toolCalls = 0;
    // #2269 — a multi-turn question's earlier turns are asked first, in the same
    // session; only the last turn is graded.
    const multiTurn = isMultiTurn(q);
    const turns = [...(q.before ?? []), q.text];
    const earlierReplies: string[] = [];
    let retrieval: TurnRetrieval | undefined;
    let rag = "";
    let reply = "";
    let loop: Awaited<ReturnType<typeof runChatToolTurn>> | null = null;
    for (const [t, userText] of turns.entries()) {
      const graded = t === turns.length - 1;
      const viaConversation = retrievalMode === "conversation";
      // The graded turn of a multi-turn question is searched both ways; only
      // the run's own mode reaches the model.
      const both = graded && multiTurn;
      // #2225 — retrieval runs as the asking user, so chunk ACLs apply as in /chat.
      const conv: RagContextCapture = { contexts: [], sources: 0 };
      const convRag =
        viaConversation || both
          ? await conversationRagContext(
              { id: row.id, projectId: scope.projectId },
              userText,
              user.id,
              conv,
            )
          : "";
      const last: RagContextCapture = { contexts: [], sources: 0 };
      const lastRag =
        !viaConversation || both
          ? await buildAutoRagContext(
              scope.projectId,
              [{ role: "user", content: userText }],
              user.id,
              undefined,
              last,
            )
          : "";
      rag = viaConversation ? convRag : lastRag;
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
            (planRetrievalQueries([...history, { role: "user", content: userText }])?.contextual ??
              null) !== null,
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
    }
    if (!loop) throw new Error(`${q.id} has no turn to ask`);
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
      ...(multiTurn ? { earlierReplies } : {}),
      ...(retrieval ? { retrieval } : {}),
    });
    const found = retrieval
      ? `, expected files retrieved conv ${retrieval.conversation.length} / last ` +
        `${retrieval.lastMessage.length} of ${retrieval.expected.length}` +
        `${retrieval.followUpDetected ? " (follow-up)" : ""}`
      : "";
    console.log(
      `${arm} ${q.id} [${i + 1}/${questions.length}]: ${score.behaviour ?? "UNSCORED"} ` +
        `(expect ${q.expect}), facts ${score.facts ? `${score.facts.stated}/${score.facts.total}` : "-"}, ` +
        `${citations.length} cites, ${toolCalls} tools, rag ${rag.length} chars${found}, ` +
        `$${(costUsd ?? Number.NaN).toFixed(4)} — total $${meter.spentUsd().toFixed(4)}`,
    );
  }
  const retrievalTurns = sessions.flatMap((s) => (s.retrieval ? [s.retrieval] : []));

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
    retrievalMode,
    flags,
    sessionToolFlags: sessionFlags,
    budgetUsd: budget,
    spentUsd: Number(meter.spentUsd().toFixed(6)),
    stoppedEarly,
    summary,
    ...(retrievalTurns.length > 0 ? { retrieval: summarizeRetrieval(retrievalTurns) } : {}),
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

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("eval:ba-qa failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
