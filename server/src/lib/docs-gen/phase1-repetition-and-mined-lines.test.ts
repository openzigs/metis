/**
 * #166 — follow-ups from the review of #163.
 *
 *  1. A Phase-1 reply cut off in a REPETITION LOOP is not split and asked
 *     again, and its usable prefix is cached, so the loop is not paid for on
 *     every run.
 *  2. A mined rule's `file:line` is backed by the source line itself: the
 *     judge checks a claim naming it against that code, so altering the line
 *     makes the claim unsupported.
 */
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk, ChatMessage } from "../ai/types.js";
import type { PersistedMinedRule } from "./fact-slices.js";
import { FaithfulnessJudge } from "./grounding/faithfulness-judge.js";
import { buildGroundingContext } from "./grounding/grounding-context.js";
import {
  MinedLineIndex,
  minedLineSourceId,
  minedLineSources,
} from "./grounding/mined-line-sources.js";
import { detectRepetitionLoop } from "./truncation.js";

const readFileMock = vi.hoisted(() => vi.fn());
const upsertMock = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const findUniqueMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock("../prisma.js", () => ({
  prisma: {
    finding: { findMany: vi.fn().mockResolvedValue([]) },
    docsGenFactCache: {
      findUnique: findUniqueMock,
      update: vi.fn().mockResolvedValue({}),
      upsert: upsertMock,
    },
  },
}));
vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(async (p: string) => path.resolve(p)),
  readFile: readFileMock,
  readdir: vi.fn().mockResolvedValue([]),
}));

import {
  extractModuleFacts,
  PHASE1_LOOP_MARKER,
  PHASE1_SPLIT_MARKER,
  type ModuleGroup,
} from "./holistic-synthesizer.js";

// ── detectRepetitionLoop ─────────────────────────────────────────────────

describe("detectRepetitionLoop (#166)", () => {
  const head = "PURPOSE\nTakes payments.\n\nRULES\n- Amount must be positive.\n\nNOTES";

  it("finds a line repeated to the cap and keeps one copy of it", () => {
    const loop = Array.from({ length: 200 }, () => "- The cache is warmed on start.").join("\n");
    const found = detectRepetitionLoop(`${head}\n${loop}`);
    expect(found).not.toBeNull();
    expect(found!.usablePrefix).toBe(`${head}\n- The cache is warmed on start.`);
  });

  it("reads lines that differ only in their numbers as one", () => {
    const loop = Array.from({ length: 60 }, (_, i) => `- Step ${i} retries the call.`).join("\n");
    const found = detectRepetitionLoop(`${head}\n${loop}`);
    expect(found?.usablePrefix).toBe(`${head}\n- Step 0 retries the call.`);
  });

  it("finds a loop inside one long line and drops that line", () => {
    const loop = "the handler logs the request and then ".repeat(120);
    const found = detectRepetitionLoop(`${head}\n- ${loop}`);
    expect(found?.usablePrefix).toBe(head);
  });

  it("does not call a reply simply cut off mid-list a loop", () => {
    const list = Array.from(
      { length: 200 },
      (_, i) =>
        `- Rule ${String.fromCharCode(65 + (i % 26))}${i}: limit applies to account type ${i % 7}.`,
    ).join("\n");
    expect(detectRepetitionLoop(`${head}\n${list}\n- cut off mid-`)).toBeNull();
    expect(detectRepetitionLoop("PURPOSE\nshort")).toBeNull();
  });
});

// ── Phase 1: a looping module is not re-extracted every run ──────────────

const LOOP_REPLY = [
  "PURPOSE\nLimits.\n\nRULES\n- rule0 enforces its limit\n\nNOTES",
  ...Array.from({ length: 300 }, () => "- The limit cache is refreshed hourly."),
].join("\n");

function bigTsSource(n: number, lines: number): string {
  return Array.from({ length: n }, (_, i) =>
    [
      `export function rule${i}(amount: number) {`,
      ...Array.from({ length: lines - 2 }, (_, k) =>
        k % 10 === 0
          ? `  if (amount > ${i * 1000 + k}) { throw new Error("limit ${i}.${k} exceeded"); }`
          : `  const step${k} = amount * ${k};`,
      ),
      "}",
    ].join("\n"),
  ).join("\n");
}

function bigTsModule(n: number, lines: number): ModuleGroup {
  return {
    dir: "src/limits",
    syms: Array.from({ length: n }, (_, i) => ({
      id: `f${i}`,
      codeGraphId: "graph-a",
      qualifiedName: `limits.ts::rule${i}`,
      kind: "function",
      language: "ts",
      filePath: "src/limits/limits.ts",
      startLine: i * lines + 1,
      endLine: (i + 1) * lines,
    })),
  };
}

/** Every Phase-1 reply is the same repetition loop, cut off at the cap. */
function loopingProvider(): AIProvider & { calls: number } {
  const p = {
    key: "scripted",
    model: "mock-local-model",
    offline: false,
    calls: 0,
    chat: vi.fn(),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
    async *stream(): AsyncGenerator<ChatChunk> {
      p.calls += 1;
      yield { type: "delta", content: LOOP_REPLY };
      yield { type: "done", finishReason: "length" };
    },
  };
  return p as unknown as AIProvider & { calls: number };
}

describe("Phase 1 — a reply cut off in a repetition loop (#166)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue({});
    readFileMock.mockResolvedValue(bigTsSource(24, 40));
  });

  it("is not split and re-asked: one call per planned chunk, the loop cut off", async () => {
    const provider = loopingProvider();
    const f = await extractModuleFacts(bigTsModule(24, 40), provider, false, "p1", "/clone");
    const planned = f!.phase1Coverage!.chunks;
    // Before #166 each looping chunk was split and every half asked again.
    expect(provider.calls).toBe(planned);
    expect(f!.factsTruncated).toBe(true);
    expect(f!.phase1Coverage!.truncatedChunks).toBe(planned);
    expect(f!.facts).toContain("- rule0 enforces its limit");
    // One copy of the looping line kept (merged chunks dedupe it further).
    const copies = f!.facts.split("The limit cache is refreshed hourly.").length - 1;
    expect(copies).toBeGreaterThanOrEqual(1);
    expect(copies).toBeLessThanOrEqual(planned);
    expect(f!.facts).not.toContain(PHASE1_LOOP_MARKER);
    // The usable prefix is cached behind the loop marker, never a split marker.
    const rows = upsertMock.mock.calls.map((c) => c[0].create.facts as string);
    expect(rows).toHaveLength(planned);
    for (const r of rows) {
      expect(r.startsWith(`${PHASE1_LOOP_MARKER}\n`)).toBe(true);
      expect(r).not.toBe(PHASE1_SPLIT_MARKER);
    }
  });

  it("costs no model call on the next run, and is still reported as cut off", async () => {
    const store = new Map<string, Record<string, unknown>>();
    upsertMock.mockImplementation(
      async (args: {
        where: { projectId_cacheKey: { cacheKey: string } };
        create: Record<string, unknown>;
      }) => {
        store.set(args.where.projectId_cacheKey.cacheKey, args.create);
        return {};
      },
    );
    findUniqueMock.mockImplementation(
      async (args: { where: { projectId_cacheKey: { cacheKey: string } } }) => {
        const row = store.get(args.where.projectId_cacheKey.cacheKey);
        return row ? { id: "r", createdAt: new Date(), model: "m", ...row } : null;
      },
    );
    const first = loopingProvider();
    const a = await extractModuleFacts(bigTsModule(24, 40), first, false, "p1", "/clone");
    const second = loopingProvider();
    const b = await extractModuleFacts(bigTsModule(24, 40), second, false, "p1", "/clone");
    expect(first.calls).toBeGreaterThan(0);
    expect(second.calls).toBe(0);
    expect(b!.facts).toBe(a!.facts);
    expect(b!.factsTruncated).toBe(true);
    expect(b!.phase1Coverage!.truncatedChunks).toBe(a!.phase1Coverage!.truncatedChunks);
    expect(b!.phase1Coverage!.functionsExtracted).toBe(0);
  });

  it("captures each mined rule's source line with a hash of its file", async () => {
    readFileMock.mockResolvedValue(bigTsSource(2, 40));
    const provider = loopingProvider();
    const f = await extractModuleFacts(bigTsModule(2, 40), provider, false, "p1", "/clone");
    expect(f!.minedRules!.length).toBeGreaterThan(0);
    const sources = f!.minedRuleSources!;
    expect(sources.length).toBeGreaterThan(0);
    const lines = bigTsSource(2, 40).split("\n");
    for (const s of sources) {
      expect(s.file).toBe("src/limits/limits.ts");
      expect(s.code.split("\n")[0]).toBe(lines[s.line - 1]);
      expect(s.fileHash).toMatch(/^[0-9a-f]{12}$/);
    }
  });
});

// ── mined rules verified against the source line ─────────────────────────

const RULE: PersistedMinedRule = {
  language: "ts",
  kind: "guard",
  expression: "amount > 1000",
  summary: "Orders over 1000 need approval",
  file: "src/orders/approve.ts",
  line: 3,
  context: "approve.ts::approve",
};

const SOURCE = [
  "export function approve(order: Order) {",
  "  const amount = order.total;",
  "  if (amount > 1000) requireManager(order);",
  "  return order;",
  "}",
];

describe("minedLineSources / MinedLineIndex (#166)", () => {
  it("keys each rule's code by file:line under a content hash", () => {
    const [s] = minedLineSources([RULE], new Map([[RULE.file, SOURCE]]));
    expect(s).toMatchObject({ file: RULE.file, line: 3, code: SOURCE[2] });
    expect(minedLineSourceId(s)).toBe(`mined:${s.fileHash}:3`);
    const edited = minedLineSources([RULE], new Map([[RULE.file, ["// x", ...SOURCE]]]));
    expect(edited[0].fileHash).not.toBe(s.fileHash);
  });

  it("keeps the continuation lines of a rule whose expression spans lines", () => {
    const multi = { ...RULE, expression: "amount > 1000 && order.region === 'EU'" };
    const src = [
      "function f() {",
      "",
      "  if (amount > 1000 &&",
      "      order.region === 'EU') x();",
    ];
    const [s] = minedLineSources([multi], new Map([[RULE.file, src]]));
    expect(s.code).toBe(`${src[2]}\n${src[3]}`);
  });

  it("skips a rule whose file was not read or whose line is past its end", () => {
    expect(minedLineSources([RULE], new Map())).toEqual([]);
    expect(minedLineSources([{ ...RULE, line: 99 }], new Map([[RULE.file, SOURCE]]))).toEqual([]);
  });

  it("resolves a claim's full or unambiguous short file:line reference", () => {
    const index = new MinedLineIndex(minedLineSources([RULE], new Map([[RULE.file, SOURCE]])));
    expect(index.resolve("Orders over 1000 need approval (src/orders/approve.ts:3).")).toHaveLength(
      1,
    );
    expect(index.resolve("Orders over 1000 need approval (approve.ts:3).")).toHaveLength(1);
    expect(index.resolve("Orders need approval (approve.ts:4).")).toHaveLength(0);
    expect(index.resolve("Orders need approval.")).toHaveLength(0);
  });
});

/** A judge that supports a claim only when its evidence holds the claim's number. */
function numberCheckingJudge() {
  const prompts: string[] = [];
  const provider = {
    key: "local-test",
    model: "judge",
    offline: false,
    chat: vi.fn(async (messages: ChatMessage[]) => {
      const user = String(messages[1].content);
      prompts.push(user);
      const evidence = user.slice(0, user.indexOf("=== CLAIMS TO JUDGE"));
      const block = user.slice(user.indexOf("=== CLAIMS TO JUDGE"));
      const claims = [...block.matchAll(/^\d+\.\s+(.*)$/gm)].map((m) => m[1].trim());
      const verdicts = claims.map((claim) => {
        const n = /\b(\d{3,})\b/.exec(claim)?.[1];
        return { claim, supported: n !== undefined && evidence.includes(n), sourceIds: [] };
      });
      return { content: JSON.stringify({ verdicts }), finishReason: "stop" };
    }),
  } as unknown as AIProvider;
  return { provider, prompts };
}

describe("a mined-rule claim is verified against the source line (#166)", () => {
  // The facts text states the rule as the miner summarised it — "1000".
  const ctx = buildGroundingContext({
    factsSources: [
      {
        moduleDir: "src/orders",
        idx: 0,
        label: "orders",
        text: "### MODULE: orders\nMINED_RULES\n- [ts guard] `amount > 1000` — Orders over 1000 need approval (src/orders/approve.ts:3)",
      },
    ],
  });
  const claim = "Orders over 1000 need manager approval (src/orders/approve.ts:3).";

  const judgeWith = async (source: string[]) => {
    const { provider, prompts } = numberCheckingJudge();
    const judge = new FaithfulnessJudge({
      provider,
      minedLines: new MinedLineIndex(minedLineSources([RULE], new Map([[RULE.file, source]]))),
    });
    const out = await judge.judge([claim], ctx, undefined, undefined, [["facts:src_orders:0"]]);
    return { verdict: out![0], prompt: prompts[0] };
  };

  it("is supported when the line says what the claim says", async () => {
    const { verdict, prompt } = await judgeWith(SOURCE);
    expect(verdict.supported).toBe(true);
    expect(prompt).toContain("kind=mined");
    expect(prompt).toContain("if (amount > 1000) requireManager(order);");
  });

  it("is unsupported once the line changes, though the facts text still agrees", async () => {
    const edited = [...SOURCE];
    edited[2] = "  if (amount > 5000) requireManager(order);";
    const { verdict, prompt } = await judgeWith(edited);
    expect(verdict.supported).toBe(false);
    // Judged on the code, not on the facts summary that still says 1000.
    expect(prompt).not.toContain("MINED_RULES");
  });

  it("a claim without a file:line keeps its cited facts evidence", async () => {
    const { provider, prompts } = numberCheckingJudge();
    const judge = new FaithfulnessJudge({
      provider,
      minedLines: new MinedLineIndex(minedLineSources([RULE], new Map([[RULE.file, SOURCE]]))),
    });
    await judge.judge(["Orders over 1000 need approval."], ctx, undefined, undefined, [
      ["facts:src_orders:0"],
    ]);
    expect(prompts[0]).toContain("MINED_RULES");
    expect(prompts[0]).not.toContain("kind=mined");
  });
});
