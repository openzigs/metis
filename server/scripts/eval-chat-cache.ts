/**
 * #1845 — `pnpm eval:chat-cache`: measure what the chat caches save and what
 * they risk, before any default changes.
 *
 *   pnpm eval:chat-cache --budget 3                       # every arm and pass
 *   pnpm eval:chat-cache --budget 12 --passes before      # the prompt-cache arms only
 *   pnpm eval:chat-cache --budget 1 --limit 4 --arms on   # a smoke run
 *
 * Over the materialized Miniflux project (`pnpm eval:materialize
 * localization-01-miniflux-heldout`, #1799) it asks every question of the
 * committed replay set (`eval-data/corpus/chatcache-01-miniflux/`) as its own
 * one-turn chat session, on the configured provider, through production's own
 * chat pieces: the session's tools (`resolveSessionTools`, approval-gated
 * tools withheld as `/chat` does with no approver present), the library
 * system prompt, the auto-RAG block, `prepareTurn` and `runChatToolTurn`.
 *
 *   1. pass `before`, arm `off` — the tool loop caches the system prefix only;
 *   2. pass `before`, arm `on`  — the shipped #1842 posture (system + transcript);
 *   3. the synthetic patch is committed to the clone and re-ingested;
 *   4. pass `after`,  arm `on`.
 *
 * The tool-result cache (#1843) is the shipped singleton, emptied before each
 * arm but NOT between the passes, so the `after` pass shows whether anything
 * computed before the re-ingest is served after it. The semantic answer cache
 * (#1844) is replayed afterwards over the `on` arm's turns at 0.92, 0.95 and
 * 0.97 (`semantic-replay.ts`): its chat-route lookup embeds with the CHAT
 * provider, which the Anthropic provider cannot do, so the replay embeds with
 * the RAG embedder instead.
 *
 * Spend is ledger-priced and held under `--budget` (USD): the run stops before
 * a session once the cap is reached, or on an unpriced call. The clone and the
 * graph are restored to the materialized commit afterwards (`--keep-patch`
 * skips that). Results: `eval-results/chat-cache/<runId>.{json,md}`.
 */
/* eslint-disable no-console -- a local CLI whose output is the report */
import "./eval-chat-cache-env.js";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  assertCommitSha,
  assertEvalDatabase,
  EVAL_USER_EMAIL,
  materializeLayout,
  readMaterializedState,
} from "../src/lib/eval/localization/materialize.js";
import {
  applyFunctionMoves,
  chatCacheCorpusDir,
  loadChatCacheFixture,
  type ChatCachePatch,
  type ChatCacheQuestion,
} from "../src/lib/eval/chat-cache/fixture.js";
import { extractCitedFiles } from "../src/lib/eval/chat-cache/cited-files.js";
import {
  formatChatCacheReport,
  summarizePromptCache,
  summarizeToolCache,
  type ChatCacheSession,
  type PromptCacheArm,
  type SessionToolCall,
  type ToolCacheOutcome,
} from "../src/lib/eval/chat-cache/report.js";
import {
  freshAgreement,
  pairSimilarities,
  replayAll,
  type ReplayTurn,
} from "../src/lib/eval/chat-cache/semantic-replay.js";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(SERVER_DIR, "..");
const DEFAULT_FIXTURE = "chatcache-01-miniflux";

/** `git` with an argument array: no shell. */
function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(env ? { env: { ...process.env, ...env } } : {}),
  }).trim();
}

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

interface SessionDetail extends ChatCacheSession {
  sessionId: string;
  seconds: number;
  turnsUsed: number;
  hasFinalAnswer: boolean;
  response: string;
  citedFiles: string[];
  ambiguousCitations: string[];
  contentVersion: string;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      fixture: { type: "string", default: DEFAULT_FIXTURE },
      arms: { type: "string", default: "off,on" },
      passes: { type: "string", default: "before,after" },
      questions: { type: "string" },
      limit: { type: "string" },
      budget: { type: "string" },
      out: { type: "string" },
      "keep-patch": { type: "boolean", default: false },
      concurrency: { type: "string", default: "1" },
      include: { type: "string", multiple: true },
    },
  });
  const budget = Number(values.budget);
  if (!values.budget || !Number.isFinite(budget) || budget <= 0) {
    throw new Error("--budget <usd> is required: the run's hard spend cap");
  }
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("--concurrency takes 1 to 16");
  }
  const arms = values.arms.split(",").map((s) => s.trim()) as PromptCacheArm[];
  if (arms.length === 0 || arms.some((a) => a !== "on" && a !== "off")) {
    throw new Error("--arms takes on and/or off");
  }
  const passes = values.passes.split(",").map((s) => s.trim());
  if (passes.some((p) => p !== "before" && p !== "after") || !passes.includes("before")) {
    throw new Error("--passes takes before, or before,after");
  }
  const runAfter = passes.includes("after");
  if (runAfter && !arms.includes("on")) throw new Error("the after pass runs the on arm");

  const { fixture, patch } = await loadChatCacheFixture(
    chatCacheCorpusDir(REPO_ROOT, values.fixture),
  );
  let questions: ChatCacheQuestion[] = fixture.questions;
  if (values.questions) {
    const wanted = new Set(values.questions.split(",").map((s) => s.trim()));
    questions = questions.filter((q) => wanted.has(q.id));
  }
  if (values.limit) questions = questions.slice(0, Number(values.limit));
  if (questions.length === 0) throw new Error("no questions selected");

  // `eval-chat-cache-env.ts` bound the environment before Prisma loaded; the
  // client's own binding is asserted below.
  const layout = materializeLayout();
  const state = await readMaterializedState(fixture.project.corpus, layout);
  if (!state) {
    throw new Error(
      `${fixture.project.corpus} is not materialized: run pnpm eval:materialize ${fixture.project.corpus}`,
    );
  }
  const repo = state.repos.find((r) => r.name === fixture.project.repo);
  if (!repo) throw new Error(`repo ${fixture.project.repo} is not in the materialized state`);
  assertCommitSha(repo.sha);
  // A run stopped mid-way (a timeout, Ctrl-C) leaves the clone on the patch
  // commit, a child of the materialized one: that, and only that, is undone below.
  const head = git(repo.cloneDir, ["rev-parse", "HEAD"]);
  const leftPatched =
    head !== repo.sha &&
    git(repo.cloneDir, ["rev-parse", "HEAD^"]) === repo.sha &&
    git(repo.cloneDir, ["log", "-1", "--format=%s"]) === patch.commit.message;
  if (head !== repo.sha && !leftPatched) {
    throw new Error(`the clone is not at ${repo.sha}: re-run pnpm eval:materialize`);
  }

  const { prisma, boundDatabaseUrl } = await import("../src/lib/prisma.js");
  assertEvalDatabase(boundDatabaseUrl, layout);
  const { buildProvider, loadAIConfig } = await import("../src/lib/ai/index.js");
  const { LedgerCostMeter, meterProvider } = await import("../src/lib/eval/localization/cost.js");
  const { getEmbedder } = await import("../src/lib/rag/embedder.js");
  const { getProjectContentVersion } = await import("../src/lib/projects/content-version.js");
  const { CACHEABLE_TOOLS, getToolResultCache } =
    await import("../src/lib/ai/tool-runtime/tool-result-cache.js");
  const {
    resolveSessionTools,
    loadSessionToolsFlags,
    offersSearchGuidance,
    sessionGate,
    withoutApprovalGatedTools,
  } = await import("../src/lib/ai/tool-runtime/session-tools.js");
  const { runChatToolTurn } = await import("../src/lib/ai/tool-runtime/chat-turn.js");
  const { prepareTurn, loadChatTurnConfig } = await import("../src/lib/ai/conversation/turn.js");
  const { buildSemanticCacheScope } = await import("../src/lib/ai/semantic-cache.js");
  const { CHAT_PROMPT_CACHING, chatToolLoopPromptCaching } =
    await import("../src/lib/ai/chat-prompt-caching.js");
  const { buildAutoRagContext, buildLibrarySystemMessages, NATIVE_CHAT_TOOL_NOTE } =
    await import("../src/routes/ai.js");
  const { messageText } = await import("../src/lib/ai/types.js");
  const { ingestCodeGraph } = await import("../src/lib/code-graph/ingest.js");
  const { embedProjectSymbols } = await import("../src/lib/code-graph/symbol-embedding-service.js");

  const provider = buildProvider({ config: loadAIConfig() });
  if (provider.offline) throw new Error("a live provider is required, not the offline stub");
  const model = provider.model;
  const meter = new LedgerCostMeter();
  const flags = { ...loadSessionToolsFlags(), codeSearchTools: true, subAgents: false };
  const config = {
    CHAT_FUSED_CODE_RETRIEVAL: process.env.CHAT_FUSED_CODE_RETRIEVAL ?? "(unset: off)",
    CHAT_TOOL_RESULT_CACHE_ENABLED: process.env.CHAT_TOOL_RESULT_CACHE_ENABLED ?? "(unset: on)",
    sessionToolFlags: flags,
  };
  console.log(
    `chat-cache: ${provider.key}/${model}, ${questions.length} questions, cap $${budget}`,
  );

  const user = await prisma.user.upsert({
    where: { email: EVAL_USER_EMAIL },
    create: {
      email: EVAL_USER_EMAIL,
      displayName: "eval-materialize",
      username: "eval-materialize",
    },
    update: {},
  });
  const embedder = getEmbedder();
  const embeddings = (await embedder.embed(questions.map((q) => q.text))).vectors;
  const repoFiles = (): string[] => git(repo.cloneDir, ["ls-files"]).split("\n").filter(Boolean);
  const toolCache = getToolResultCache();

  const sessions: SessionDetail[] = [];
  const replayTurns: ReplayTurn[] = [];
  let stoppedEarly: string | null = null;

  // Which session a tool-result-cache lookup belongs to: sessions run
  // concurrently against the one shipped cache, so its counters cannot be
  // diffed; each lookup's outcome is queued on the session that made it, and
  // calls within a session run one at a time.
  // `seq` is taken at LOOKUP time: a miss's lookup precedes its store, which
  // precedes any hit on the entry, whatever order the calls finish in.
  const lookupQueue = new AsyncLocalStorage<Array<{ outcome: ToolCacheOutcome; seq: number }>>();
  let callSeq = 0;
  const count = toolCache.count.bind(toolCache);
  toolCache.count = (tool, outcome) => {
    count(tool, outcome);
    lookupQueue.getStore()?.push({ outcome, seq: callSeq++ });
  };

  async function runPass(arm: PromptCacheArm, pass: string): Promise<void> {
    const files = repoFiles();
    const version = await getProjectContentVersion(repo!.projectId);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < questions.length && !stoppedEarly) {
        const i = next++;
        if (meter.unpricedCalls() > 0) {
          stoppedEarly = "an unpriced call: the cap cannot be enforced";
          return;
        }
        if (meter.spentUsd() >= budget) {
          stoppedEarly = `the $${budget} cap was reached`;
          return;
        }
        await lookupQueue.run([], () => runSession(arm, pass, i, files, version.key));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, questions.length) }, worker));
  }

  async function runSession(
    arm: PromptCacheArm,
    pass: string,
    i: number,
    files: string[],
    versionKey: string,
  ): Promise<void> {
    {
      const q = questions[i];
      const t0 = performance.now();
      const row = await prisma.aISession.create({
        data: {
          userId: user.id,
          projectId: repo!.projectId,
          provider: provider.key,
          model,
          title: `eval #1845 ${arm}/${pass} ${q.id}`,
        },
      });
      const session = {
        id: row.id,
        userId: user.id,
        projectId: repo!.projectId,
        agentId: null,
        loadedSkillIds: row.loadedSkillIds,
        policy: row.policy,
      };
      const resolved = await resolveSessionTools({ session, provider, model, flags, mcp: null });
      // `/chat` with nobody to approve: a tool that would need a person is not offered.
      const tools = (await withoutApprovalGatedTools(resolved, session, async () => false)).runtime;
      const library = await buildLibrarySystemMessages(
        session,
        tools.mode === "native" ? NATIVE_CHAT_TOOL_NOTE : tools.schemaBlock,
        { mode: tools.skillMode, catalog: tools.skillCatalog },
        offersSearchGuidance(tools),
      );
      const prefix = [...library.stable, ...library.volatile];
      const rag = await buildAutoRagContext(
        repo!.projectId,
        [{ role: "user", content: q.text }],
        user.id,
      );
      const turn = await prepareTurn({
        session: { id: row.id, snapshot: null },
        userText: q.text,
        prefix,
        beforeUser: rag ? [{ role: "system", content: rag }] : [],
        provider: provider.key,
        model,
        summarizer: async () => {
          throw new Error("a one-question session never compacts");
        },
        config: loadChatTurnConfig(null),
        ...(tools.mode === "native" ? { nativeTools: tools.toolset.specs() } : {}),
      });
      const scope = await buildSemanticCacheScope({
        model,
        messages: turn.messages,
        projectId: repo!.projectId,
        userId: user.id,
      });

      const sessionMeter = new LedgerCostMeter();
      // Every call is priced twice over: into the run's cap and into this session.
      const metered = meterProvider(meterProvider(provider, meter), sessionMeter);
      const usage = {
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        calls: 0,
      };
      const toolCalls: SessionToolCall[] = [];
      const loop = await runChatToolTurn(
        metered,
        {
          messages: turn.messages,
          toolset: tools.toolset,
          native: tools.mode === "native",
          ctx: { sessionId: row.id, userId: user.id, projectId: repo!.projectId },
          gate: sessionGate({ session, runtime: tools }),
        },
        {
          providerChatOptions: {
            sessionId: row.id,
            model,
            callType: "chat",
            promptCaching: arm === "on" ? chatToolLoopPromptCaching(provider) : CHAT_PROMPT_CACHING,
          },
          toolResultMaxChars: turn.build.toolResultMaxChars,
          onUsage: (u) => {
            usage.promptTokens += u.promptTokens;
            usage.completionTokens += u.completionTokens;
            usage.cacheReadTokens += u.cacheReadTokens ?? 0;
            usage.cacheWriteTokens += u.cacheWriteTokens ?? 0;
            usage.calls++;
          },
          // A cached tool counted its lookup before the call finished.
          onToolRecord: (rec) => {
            const queued = CACHEABLE_TOOLS.has(rec.tool)
              ? lookupQueue.getStore()?.shift()
              : undefined;
            toolCalls.push({
              tool: rec.tool,
              args: rec.args,
              outcome: queued?.outcome ?? "uncached",
              seq: queued?.seq ?? callSeq++,
            });
          },
        },
      );
      const spent = sessionMeter.spentUsd();
      const cited = extractCitedFiles(loop.replyText, files, repo!.name);
      const detail: SessionDetail = {
        arm,
        pass,
        questionId: q.id,
        usage,
        costUsd: sessionMeter.unpricedCalls() > 0 ? null : spent,
        toolCalls,
        sessionId: row.id,
        seconds: Number(((performance.now() - t0) / 1000).toFixed(1)),
        turnsUsed: loop.turnsUsed,
        hasFinalAnswer: loop.loop.hasFinalAnswer,
        response: loop.replyText,
        citedFiles: cited.files,
        ambiguousCitations: cited.ambiguous,
        contentVersion: versionKey,
      };
      sessions.push(detail);
      if (arm === "on" && scope) {
        const stable = prefix.filter((m) => m.role === "system").map((m) => messageText(m));
        replayTurns.push({
          pass,
          questionId: q.id,
          text: q.text,
          embedding: embeddings[i],
          response: loop.replyText,
          citedFiles: cited.files,
          toolCallCount: toolCalls.length,
          scope,
          stableSystemHash: sha256(stable.join("\n")),
        });
      }
      console.log(
        `${arm}/${pass} ${q.id} [${i + 1}/${questions.length}]: ${usage.calls} calls, ` +
          `${toolCalls.length} tools (${toolCalls.filter((c) => c.outcome === "hit").length} cached), ` +
          `read ${usage.cacheReadTokens} / in ${usage.promptTokens + usage.cacheReadTokens + usage.cacheWriteTokens}, ` +
          `$${spent.toFixed(4)}, cites ${cited.files.length} — total $${meter.spentUsd().toFixed(4)}`,
      );
    }
  }

  async function ingestAt(sha: string): Promise<void> {
    await ingestCodeGraph(prisma, {
      projectId: repo!.projectId,
      rootDir: repo!.cloneDir,
      repoConnectionId: repo!.connectorId,
      commitSha: sha,
      incremental: false,
      triggeredByUserId: user.id,
      sqlLineageOverride: false,
    });
    await embedProjectSymbols(repo!.projectId);
  }

  async function applyPatch(p: ChatCachePatch): Promise<string> {
    const read = (rel: string): string | null => {
      const abs = path.join(repo!.cloneDir, rel);
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    };
    for (const [rel, text] of applyFunctionMoves(p.moves, read)) {
      await fs.writeFile(path.join(repo!.cloneDir, rel), text, "utf8");
    }
    git(repo!.cloneDir, ["add", "-A"]);
    // A fixed author and date: the same patch on the same commit is the same SHA.
    git(repo!.cloneDir, ["commit", "--quiet", "--no-verify", "-m", p.commit.message], {
      GIT_AUTHOR_NAME: p.commit.authorName,
      GIT_AUTHOR_EMAIL: p.commit.authorEmail,
      GIT_AUTHOR_DATE: p.commit.date,
      GIT_COMMITTER_NAME: p.commit.authorName,
      GIT_COMMITTER_EMAIL: p.commit.authorEmail,
      GIT_COMMITTER_DATE: p.commit.date,
    });
    return git(repo!.cloneDir, ["rev-parse", "HEAD"]);
  }

  function checkoutBase(): void {
    git(repo!.cloneDir, [
      "-c",
      "advice.detachedHead=false",
      "checkout",
      "--quiet",
      "--detach",
      repo!.sha,
    ]);
  }
  if (leftPatched) {
    console.log("an earlier run left the patch applied: restoring the clone and graph first");
    checkoutBase();
    await ingestAt(repo.sha);
  }

  const startedAt = new Date();
  const versions: Record<string, string> = {};
  let patchedSha: string | null = null;
  try {
    versions.before = (await getProjectContentVersion(repo.projectId)).key;
    for (const arm of [...arms].sort()) {
      // Each arm starts with an empty tool-result cache: its hits are its own.
      toolCache.clear();
      await runPass(arm, "before");
      if (stoppedEarly) break;
    }
    if (runAfter && !stoppedEarly) {
      patchedSha = await applyPatch(patch);
      await ingestAt(patchedSha);
      versions.after = (await getProjectContentVersion(repo.projectId)).key;
      if (versions.after === versions.before) {
        throw new Error("the re-ingest did not move the content version");
      }
      console.log(`re-ingested at ${patchedSha.slice(0, 12)}: content version moved`);
      // NOT cleared: entries from the before pass are still in the cache.
      await runPass("on", "after");
    }
  } finally {
    if (patchedSha && !values["keep-patch"]) {
      checkoutBase();
      await ingestAt(repo.sha);
      console.log(`restored the clone and graph to ${repo.sha.slice(0, 12)}`);
    }
  }

  // Report in question order, whatever order the sessions finished in.
  const order = (pass: string, id: string): number =>
    (pass === "before" ? 0 : 1) * questions.length + questions.findIndex((q) => q.id === id);
  sessions.sort(
    (a, b) =>
      a.arm.localeCompare(b.arm) || order(a.pass, a.questionId) - order(b.pass, b.questionId),
  );
  replayTurns.sort((a, b) => order(a.pass, a.questionId) - order(b.pass, b.questionId));

  // An arm run by an earlier invocation (`--include`), reported alongside this one.
  const included: string[] = [];
  const reported: ChatCacheSession[] = [...sessions];
  for (const file of values.include ?? []) {
    const prior = JSON.parse(await fs.readFile(path.resolve(file), "utf8")) as {
      runId: string;
      provider: string;
      model: string;
      fixture: { id: string };
      sessions: ChatCacheSession[];
    };
    if (
      prior.fixture.id !== fixture.id ||
      prior.provider !== provider.key ||
      prior.model !== model
    ) {
      throw new Error(`${file} is another fixture or model: not comparable`);
    }
    reported.push(...prior.sessions.filter((x) => !arms.includes(x.arm)));
    included.push(prior.runId);
  }
  const reportedArms = [...new Set(reported.map((x) => x.arm))].sort();
  const promptCache = summarizePromptCache(reported);
  const toolCacheSummary = [
    ...reportedArms.map((a) => summarizeToolCache(reported, a, "before")),
    ...(runAfter ? [summarizeToolCache(reported, "on", "after", "before")] : []),
  ];
  const semantic = await replayAll(
    replayTurns,
    fixture.pairs,
    undefined,
    patch.moves.map((m) => m.to),
  );
  const agreement = freshAgreement(replayTurns, fixture.pairs);
  const similarities = pairSimilarities(
    fixture.pairs,
    new Map(questions.map((q, i) => [q.id, embeddings[i]])),
  );
  const runId = startedAt.toISOString().replace(/[:.]/g, "-");
  const envelope = {
    kind: "chat-cache",
    version: 1,
    issue: 1845,
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    provider: provider.key,
    model,
    fixture: { id: fixture.id, questions: questions.length, pairs: fixture.pairs.length },
    project: {
      corpus: fixture.project.corpus,
      repo: repo.name,
      baseSha: repo.sha,
      patchedSha,
      patch: patch.id,
    },
    contentVersions: versions,
    config,
    budgetUsd: budget,
    spentUsd: Number(meter.spentUsd().toFixed(6)),
    stoppedEarly,
    concurrency,
    included,
    promptCache,
    toolCache: toolCacheSummary,
    semanticCache: semantic.map(({ detail, ...rest }) => ({ ...rest, hits_detail: detail })),
    freshAgreement: agreement,
    pairSimilarities: similarities,
    sessions,
  };
  const markdown = formatChatCacheReport({
    title: `Chat cache measurement (#1845) — ${runId}`,
    provider: provider.key,
    model,
    promptCache,
    toolCache: toolCacheSummary,
    semantic,
    agreement,
    similarities,
    spentUsd: meter.spentUsd(),
  });
  const outDir = values.out
    ? path.resolve(values.out)
    : path.join(REPO_ROOT, "eval-results", "chat-cache");
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
    console.error("eval:chat-cache failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
