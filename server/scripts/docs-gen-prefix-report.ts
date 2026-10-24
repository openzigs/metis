/**
 * Issue #1329 — where do sibling docs-gen section calls stop sharing a prompt
 * prefix? DeepSeek caches automatically, but only a prefix that matches from
 * token 0, so a call reads back only the bytes it shares with an earlier call.
 *
 * This replays Phase 2 of a stored business-requirements run OFFLINE, through
 * the real prompt-assembly path (`synthesizeFinalDocument`, the topic plan and
 * the section batching): its Phase-1 facts are read from the run's
 * `docs_gen_fact_cache` rows (`docs-gen-run-facts.ts`), a fake model records
 * every section prompt, and each section is given retrieved grounding the size
 * production retrieves (`--rag-chunks` chunks of `--rag-chars` characters,
 * within the 60K per-section budget, distinct per section), standing in for
 * the repository excerpts a run with source on disk is given. No model is
 * called; the fake model's `chat` (claim extraction, judge) refuses, so
 * nothing is fact-checked.
 *
 * For every call it prints the first byte at which its prompt (system, NUL,
 * user, as one stream) differs from the previous call of the same section and
 * from the previous section's first call, and the block that byte falls in.
 *
 * It also prints what a DeepSeek-like cache could READ: DeepSeek writes a
 * prefix only when the call that sent it has finished, so a call reads the
 * longest prefix it shares with a call that ENDED before it started. The fake
 * model takes a moment per call, so the section's batches overlap as they do
 * in production (`DOCS_GEN_PHASE2_CONCURRENCY`, 4 on a cloud provider). The
 * same figure is given without the #1329 warm-up (a `…-warmup-…` call, one
 * output token): its calls removed, and the section's first wave of batches
 * started when the warm-up started.
 *
 *   DATABASE_URL=file:/nonexistent npx tsx scripts/docs-gen-prefix-report.ts \
 *     --db ../server/dev.db --version cmvjc1fv30031qk9kwll8qds7
 *
 * The database is opened READ-ONLY (`readonly: true, fileMustExist: true`).
 * Point DATABASE_URL anywhere harmless: nothing here should touch Prisma.
 */
/* eslint-disable no-console -- a local CLI whose output is the table it prints */
import Database from "better-sqlite3";
import { AIProviderError } from "../src/lib/ai/errors.js";
import { PREFIX_WARM_UP_MAX_TOKENS } from "../src/lib/ai/prompt-cache-warmup.js";
import type { AIProvider, ChatChunk, ChatMessage, ChatOptions } from "../src/lib/ai/types.js";
import type { CodeGraphSummary } from "../src/lib/docs-gen/code-graph-summary.js";
import { buildGroundingContext } from "../src/lib/docs-gen/grounding/grounding-context.js";
import {
  docsGenTuning,
  synthesizeFinalDocument,
  type ModuleFacts,
  type Phase2Router,
} from "../src/lib/docs-gen/holistic-synthesizer.js";
import { moduleFactsFromRows, positiveNumberArg, selectRunFactRows } from "./docs-gen-run-facts.js";

interface Args {
  db: string;
  version: string;
  factsWindowMin: number;
  ragChunks: number;
  ragChars: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    db: get("db") ?? "dev.db",
    version: get("version") ?? "cmvjc1fv30031qk9kwll8qds7",
    factsWindowMin: positiveNumberArg(argv, "facts-window-min", 30),
    ragChunks: positiveNumberArg(argv, "rag-chunks", 29, { integer: true }),
    ragChars: positiveNumberArg(argv, "rag-chars", 2_048, { integer: true }),
  };
}

/** The run's Phase-1 facts, as `eval-brd-plan-replay.ts` reads them. */
function loadFacts(args: Args): { facts: ModuleFacts[]; model: string; projectId: string } {
  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  try {
    const version = db
      .prepare(
        `select v.provenanceManifest as manifest, v.createdAt as createdAt, g.projectId as projectId
         from generated_document_versions v join generated_documents g on g.id = v.documentId
         where v.id = ?`,
      )
      .get(args.version) as { manifest: string; createdAt: string; projectId: string } | undefined;
    if (!version) throw new Error(`no generated document version ${args.version}`);
    const manifest = JSON.parse(version.manifest) as {
      sectionSynthesis: { records: Array<{ metadata: { model?: string } }> };
    };
    const model = manifest.sectionSynthesis.records[0]?.metadata.model ?? "";
    const facts = moduleFactsFromRows(
      selectRunFactRows(db, {
        projectId: version.projectId,
        model,
        publishedAt: version.createdAt,
        windowMin: args.factsWindowMin,
      }),
    );
    return { facts, model, projectId: version.projectId };
  } finally {
    db.close();
  }
}

interface Captured {
  section: string;
  stream: string;
  warmUp: boolean;
  /** Positions in the run's start/end event order. */
  start: number;
  end: number;
}

function recordingModel(model: string, calls: Captured[]): AIProvider {
  let clock = 0;
  return {
    key: "anthropic",
    model,
    // A stored DeepSeek run was served by DeepSeek's own API (#1329).
    deepSeekPrefixCache: /deepseek/i.test(model),
    offline: false,
    async *stream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<ChatChunk> {
      const text = (m: ChatMessage | undefined) =>
        typeof m?.content === "string"
          ? m.content
          : (m?.content ?? []).map((p) => ("text" in p ? p.text : "")).join("");
      const system = text(messages.find((m) => m.role === "system"));
      const user = text(messages[messages.length - 1]);
      const section = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "?";
      const call: Captured = {
        section,
        stream: `${system}\u0000${user}`,
        warmUp: opts.maxTokens === PREFIX_WARM_UP_MAX_TOKENS,
        start: clock++,
        end: Number.POSITIVE_INFINITY,
      };
      calls.push(call);
      // A moment per call, so a wave of parallel batches overlaps.
      await new Promise((r) => setTimeout(r, 5));
      yield { type: "delta", content: `## ${section}\n\nRecorded.` };
      call.end = clock++;
      yield { type: "done", finishReason: "stop" };
    },
    async chat(): Promise<never> {
      throw new AIProviderError("offline replay: no fact-checking", 400);
    },
    async embed(): Promise<never> {
      throw new Error("embed not used");
    },
    async models(): Promise<string[]> {
      return [];
    },
    async ping(): Promise<boolean> {
      return true;
    },
  } as unknown as AIProvider;
}

/** The block a stream offset falls in: the last block marker at or before it. */
const MARKERS: Array<[string, string]> = [
  ["SECTION GROUP TO PRODUCE:", "system: section instructions"],
  ["GROUNDING DISCIPLINE", "system: grounding discipline"],
  ["\u0000Project: ", "user: document lead"],
  ["=== END-TO-END FLOW", "user: flow graph"],
  ["Section group: **", "user: section label"],
  ["=== EXTRACTED MODULE FACTS ===", "user: module facts"],
  ["=== FORMULAS/CONSTANTS", "user: formulas"],
  ["=== RETRIEVED GROUNDING SOURCES", "user: grounding sources"],
  ["[SOURCE id=rag:", "user: retrieved excerpts"],
  ["[SOURCE id=facts:", "user: facts source ids"],
  ["=== LENGTH LIMIT", "user: length note"],
  ["=== CANONICAL FACTS", "user: canonical facts"],
  ["Write the markdown for the", "user: closing ask"],
];

function blockAt(stream: string, offset: number): string {
  let best = "system: writer brief";
  let at = -1;
  for (const [marker, name] of MARKERS) {
    const i = stream.lastIndexOf(marker, offset);
    if (i > at) {
      at = i;
      best = name;
    }
  }
  return best;
}

const commonPrefix = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * The bytes of each call's prompt a finish-time prefix cache could read: the
 * longest prefix it shares with a call that ended before it started. Without
 * the warm-up, its calls are dropped and the batches of a section that started
 * before any of that section's batches had ended (its first wave) are taken to
 * start when the warm-up did.
 */
function readableBytes(calls: readonly Captured[], withWarmUp: boolean): Map<Captured, number> {
  const kept = withWarmUp ? calls : calls.filter((c) => !c.warmUp);
  const startOf = new Map<Captured, number>();
  for (const c of kept) {
    let start = c.start;
    if (!withWarmUp) {
      const warmUp = calls.find((w) => w.warmUp && w.section === c.section);
      const siblings = kept.filter((s) => s.section === c.section && s !== c);
      const firstWave = siblings.every((s) => s.end > c.start);
      if (warmUp && firstWave) start = warmUp.start;
    }
    startOf.set(c, start);
  }
  const out = new Map<Captured, number>();
  for (const c of kept) {
    let best = 0;
    for (const p of kept) {
      if (p === c || p.end >= startOf.get(c)!) continue;
      best = Math.max(best, commonPrefix(p.stream, c.stream));
    }
    out.set(c, bytes(c.stream.slice(0, best)));
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { facts, model, projectId } = loadFacts(args);
  if (facts.length === 0) {
    throw new Error(
      `no Phase-1 facts for ${args.version}: none created by its publication and used in the ${args.factsWindowMin} minutes before it; widen --facts-window-min`,
    );
  }
  const calls: Captured[] = [];
  const provider = recordingModel(model, calls);
  const tuning = docsGenTuning("anthropic", model);
  const router: Phase2Router = {
    primary: {
      kind: "anthropic",
      provider,
      supportsCaching: true,
      factsCharCap: tuning.factsCharCap,
      tuning,
    },
    hybrid: null,
  };
  // A flow graph shaped like a real one: each module hands off to the next.
  const dirs = facts.map((f) => f.modulePath);
  const graphSummary: CodeGraphSummary = {
    perModuleLineage: new Map(),
    datasetLineage: [],
    crossModuleDeps: new Map(dirs.map((d, i) => [d, new Set([dirs[(i + 1) % dirs.length]])])),
  };
  const filler = "func handle(ctx context.Context) error { return validate(ctx, request) } ";
  const groundingForSection = async (req: { id: string }) =>
    buildGroundingContext({
      ragChunks: Array.from({ length: args.ragChunks }, (_, i) => ({
        documentId: `doc-${req.id}-${i}`,
        chunkId: `chunk-${req.id}-${i}`,
        filename: `connector:repo:fixture:internal/${req.id}/file${i}.go`,
        evidenceClass: "repository-source" as const,
        text: `// ${req.id} excerpt ${i}\n${filler.repeat(Math.ceil(args.ragChars / filler.length))}`.slice(
          0,
          args.ragChars,
        ),
      })),
      charBudget: 60_000,
    });
  const meta = {
    name: "miniflux",
    totalFiles: 600,
    totalSymbols: 9_000,
    language: "go",
  } as never;
  await synthesizeFinalDocument(
    facts,
    meta,
    "business-requirements",
    "BRD — #1329 prefix replay",
    router,
    projectId,
    undefined,
    undefined,
    groundingForSection,
    graphSummary,
  );

  const readable = readableBytes(calls, true);
  const readableBefore = readableBytes(calls, false);
  console.log(`modules: ${facts.length}, model: ${model}, calls: ${calls.length}`);
  console.log(
    "| # | section | call | prompt bytes | shared w/ previous batch | diverges in | shared w/ previous section | diverges in | readable (finished calls) |",
  );
  console.log("|---:|---|---:|---:|---:|---|---:|---|---:|");
  let prevSectionFirst: Captured | null = null;
  let batchShared = 0;
  let batchTotal = 0;
  let sectionShared = 0;
  let total = 0;
  const firstOf = new Map<string, Captured>();
  calls.forEach((c, i) => {
    const prior = calls.slice(0, i).filter((p) => p.section === c.section);
    const prev = prior[prior.length - 1];
    total += bytes(c.stream);
    let batchCol = "—";
    let batchBlock = "";
    if (prev) {
      const n = commonPrefix(prev.stream, c.stream);
      batchShared += bytes(c.stream.slice(0, n));
      batchTotal += bytes(c.stream);
      batchCol = String(bytes(c.stream.slice(0, n)));
      batchBlock = blockAt(c.stream, n);
    }
    let sectionCol = "—";
    let sectionBlock = "";
    if (!firstOf.has(c.section)) {
      firstOf.set(c.section, c);
      if (prevSectionFirst) {
        const n = commonPrefix(prevSectionFirst.stream, c.stream);
        sectionShared += bytes(c.stream.slice(0, n));
        sectionCol = String(bytes(c.stream.slice(0, n)));
        sectionBlock = blockAt(c.stream, n);
      }
      prevSectionFirst = c;
    }
    const call = c.warmUp ? "warm-up" : String(prior.filter((p) => !p.warmUp).length + 1);
    console.log(
      `| ${i + 1} | ${c.section} | ${call} | ${bytes(c.stream)} | ${batchCol} | ${batchBlock} | ${sectionCol} | ${sectionBlock} | ${readable.get(c)} |`,
    );
  });
  console.log(
    `\nsibling batches: ${batchShared} of ${batchTotal} bytes shared with the previous batch (${((100 * batchShared) / Math.max(batchTotal, 1)).toFixed(1)}%)`,
  );
  console.log(
    `section firsts: ${sectionShared} bytes shared with the previous section's first call`,
  );
  console.log(
    `upper bound on cache-read share from these prefixes: ${((100 * (batchShared + sectionShared)) / Math.max(total, 1)).toFixed(1)}% of ${total} prompt bytes`,
  );
  const share = (m: Map<Captured, number>) => {
    let read = 0;
    let sent = 0;
    for (const [c, n] of m) {
      read += n;
      sent += bytes(c.stream);
    }
    return { read, sent, pct: ((100 * read) / Math.max(sent, 1)).toFixed(1) };
  };
  const after = share(readable);
  const before = share(readableBefore);
  const warmUps = calls.filter((c) => c.warmUp);
  console.log(
    `readable from finished calls, with the warm-up: ${after.read} of ${after.sent} bytes (${after.pct}%), ${warmUps.length} warm-up calls of ${warmUps.reduce((n, c) => n + bytes(c.stream), 0)} bytes`,
  );
  console.log(
    `readable from finished calls, without it: ${before.read} of ${before.sent} bytes (${before.pct}%)`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
