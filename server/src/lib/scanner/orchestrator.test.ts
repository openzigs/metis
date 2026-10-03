/** Epic #708 / Issue #711 — orchestrator tests via in-memory ports. */
import { describe, expect, it, vi } from "vitest";
import {
  type ScanPersistedFinding,
  type ScanRecordSnapshot,
  type ScannerPorts,
  type SymbolToScan,
  type ScanProgress,
  MAX_CONSECUTIVE_SYMBOL_FAILURES,
  runScan,
} from "./orchestrator.js";
import type { CandidateFinding } from "./types.js";
import type { ChatResponse } from "../ai/types.js";
import { ScannerJsonParseError } from "./llm-client.js";
import { TaskAbortError } from "../scheduler/task-abort.js";

function makeScan(overrides: Partial<ScanRecordSnapshot> = {}): ScanRecordSnapshot {
  return {
    id: "scan-1",
    projectId: "p1",
    repoConnectionId: "r1",
    commitSha: "abc123",
    mode: "rules",
    budgetCapTokens: 1000,
    createdById: "u1",
    ...overrides,
  };
}

function makeSym(overrides: Partial<SymbolToScan> = {}): SymbolToScan {
  return {
    id: "s1",
    qualifiedName: "src/foo.ts::bar",
    kind: "function",
    language: "ts",
    filePath: "src/foo.ts",
    startLine: 1,
    endLine: 10,
    ...overrides,
  };
}

function candidate(overrides: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    ruleId: "r1",
    symbolId: "s1",
    qualifiedName: "src/foo.ts::bar",
    filePath: "src/foo.ts",
    title: "bug",
    body: "details",
    severity: "high",
    category: "security",
    evidenceLines: [3],
    confidence: 0.7,
    ...overrides,
  };
}

interface Recorder {
  ports: ScannerPorts;
  state: {
    running: { id: string; sha: string } | null;
    completed: { id: string; summary: unknown } | null;
    failed: { id: string; reason: string; summary?: unknown } | null;
    audit: Array<{ event: string; meta?: Record<string, unknown> }>;
    upserts: ScanPersistedFinding[];
    progress: ScanProgress[];
    discarded: Array<{ scanId: string; symbolId: string }>;
  };
}

function recorder(opts: {
  scan?: ScanRecordSnapshot;
  graphSha?: string | null;
  symbols?: SymbolToScan[];
  body?: string;
  candidatesFor?: (sym: SymbolToScan) => CandidateFinding[];
  fpKeep?: boolean;
  firstPassTokens?: number;
  fpTokens?: number;
  readSymbolBody?: (scan: ScanRecordSnapshot, sym: SymbolToScan) => Promise<string>;
}): Recorder {
  const scan = opts.scan ?? makeScan();
  const state: Recorder["state"] = {
    running: null,
    completed: null,
    failed: null,
    audit: [],
    upserts: [],
    progress: [],
    discarded: [],
  };
  const ports: ScannerPorts = {
    loadScan: vi.fn().mockResolvedValue(scan),
    graphCommitSha: vi
      .fn()
      .mockResolvedValue(opts.graphSha === undefined ? scan.commitSha : opts.graphSha),
    listSymbols: vi.fn().mockResolvedValue(opts.symbols ?? [makeSym()]),
    readSymbolBody:
      opts.readSymbolBody ?? vi.fn().mockResolvedValue(opts.body ?? "function bar(){}"),
    ruleInstructions: vi.fn().mockResolvedValue("rules"),
    runFirstPass: vi.fn().mockImplementation(async ({ symbol }) => ({
      candidates: opts.candidatesFor
        ? opts.candidatesFor(symbol)
        : [candidate({ symbolId: symbol.id })],
      totalTokens: opts.firstPassTokens ?? 100,
    })),
    runFpFilter: vi.fn().mockResolvedValue({
      keep: opts.fpKeep ?? true,
      finalConfidence: 0.9,
      rationales: ["yep"],
      totalTokens: opts.fpTokens ?? 50,
    }),
    upsertFinding: vi.fn().mockImplementation(async (_id: string, f: ScanPersistedFinding) => {
      state.upserts.push(f);
    }),
    recordProgress: vi.fn().mockImplementation(async (_id: string, p: ScanProgress) => {
      state.progress.push({ ...p });
    }),
    discardSymbolFindings: vi.fn().mockImplementation(async (scanId: string, symbolId: string) => {
      state.discarded.push({ scanId, symbolId });
    }),
    markRunning: vi.fn().mockImplementation(async (id: string, sha: string) => {
      state.running = { id, sha };
    }),
    markFailed: vi
      .fn()
      .mockImplementation(async (id: string, reason: string, summary?: unknown) => {
        state.failed = { id, reason, summary };
      }),
    markCompleted: vi.fn().mockImplementation(async (id: string, summary: unknown) => {
      state.completed = { id, summary };
    }),
    audit: vi
      .fn()
      .mockImplementation(async (event: string, _id: string, meta?: Record<string, unknown>) => {
        state.audit.push({ event, meta });
      }),
  };
  return { ports, state };
}

describe("runScan", () => {
  it("happy path: scans symbols and persists kept findings", async () => {
    const r = recorder({});
    const res = await runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal });
    expect(res.symbolsScanned).toBe(1);
    expect(res.candidatesKept).toBe(1);
    expect(r.state.running?.sha).toBe("abc123");
    expect(r.state.completed?.id).toBe("scan-1");
    expect(r.state.upserts.length).toBe(1);
    expect(r.state.upserts[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(r.state.audit.map((a) => a.event)).toContain("scanner.scan.start");
    expect(r.state.audit.map((a) => a.event)).toContain("scanner.scan.complete");
  });

  it("freshness gate: bails when graph SHA != scan SHA", async () => {
    const r = recorder({ graphSha: "deadbeef" });
    const res = await runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal });
    expect(res.bailedOnFreshness).toBe(true);
    expect(res.candidatesKept).toBe(0);
    expect(r.state.failed).not.toBeNull();
    // The failed row keeps the run's summary rather than resetting counters to 0/0.
    expect(r.state.failed?.summary).toMatchObject({ bailedOnFreshness: true });
    expect(r.ports.listSymbols).not.toHaveBeenCalled();
  });

  it("language filter: drops unsupported languages before any LLM call", async () => {
    const r = recorder({ symbols: [makeSym({ language: "rust" })] });
    const res = await runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal });
    expect(res.symbolsScanned).toBe(0);
    expect(r.ports.runFirstPass).not.toHaveBeenCalled();
  });

  it("budget cap: stops once tokenSpend >= budget", async () => {
    const r = recorder({
      scan: makeScan({ budgetCapTokens: 100 }),
      symbols: [makeSym({ id: "a" }), makeSym({ id: "b" }), makeSym({ id: "c" })],
      firstPassTokens: 100,
    });
    const res = await runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal });
    expect(res.bailedOnBudget).toBe(true);
    expect(res.symbolsScanned).toBeLessThanOrEqual(2);
  });

  it("drops candidates the FP filter rejects", async () => {
    const r = recorder({ fpKeep: false });
    const res = await runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal });
    expect(res.candidatesProduced).toBe(1);
    expect(res.candidatesKept).toBe(0);
    expect(r.state.upserts).toEqual([]);
  });

  it("skips candidates with no evidence lines", async () => {
    const r = recorder({
      candidatesFor: (s) => [candidate({ symbolId: s.id, evidenceLines: [] })],
    });
    const res = await runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal });
    expect(res.candidatesKept).toBe(0);
    expect(r.ports.runFpFilter).not.toHaveBeenCalled();
  });

  it("skips symbols whose body cannot be read", async () => {
    const r = recorder({
      readSymbolBody: vi.fn().mockRejectedValue(new Error("ENOENT")),
    });
    const res = await runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal });
    expect(res.symbolsScanned).toBe(0);
  });

  it("returns existing scan-not-found as a thrown error", async () => {
    const ports = recorder({}).ports;
    ports.loadScan = vi.fn().mockResolvedValue(null);
    await expect(
      runScan(ports, { scanId: "missing", signal: new AbortController().signal }),
    ).rejects.toThrow(/scan missing not found/);
  });

  it("marks scan failed when runFirstPass throws", async () => {
    const r = recorder({});
    r.ports.runFirstPass = vi.fn().mockRejectedValue(new Error("LLM down"));
    await expect(
      runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal }),
    ).rejects.toThrow(/LLM down/);
    expect(r.state.failed).not.toBeNull();
    expect(r.state.failed?.reason).toBe("LLM down");
  });

  it("#759 — an abort between symbols stops the scan and never marks it completed", async () => {
    const ac = new AbortController();
    const r = recorder({
      symbols: [makeSym({ id: "a" }), makeSym({ id: "b" })],
    });
    r.ports.runFirstPass = vi.fn().mockImplementation(async ({ symbol }) => {
      if (symbol.id === "a") ac.abort();
      return { candidates: [], totalTokens: 10 };
    });
    await expect(runScan(r.ports, { scanId: "scan-1", signal: ac.signal })).rejects.toThrow(
      /interrupted/,
    );
    expect(r.ports.runFirstPass).toHaveBeenCalledTimes(1);
    expect(r.state.completed).toBeNull();
    expect(r.state.failed?.summary).toMatchObject({ symbolsScanned: 1 });
    // The finished symbol's progress was persisted before the abort was seen.
    expect(r.state.progress.at(-1)).toMatchObject({ symbolCursor: 1, symbolsScanned: 1 });
  });

  // ---------------------------------------------------------------------------
  // #718 — one unparseable model reply must not abort the whole scan.
  // ---------------------------------------------------------------------------

  function parseError(totalTokens = 40): ScannerJsonParseError {
    return new ScannerJsonParseError("no JSON object/array found in model output", "", {
      content: "",
      usage: { promptTokens: 30, completionTokens: 10, totalTokens },
    } as ChatResponse);
  }

  it("skips a symbol whose reply is unparseable and completes the scan", async () => {
    const r = recorder({
      symbols: [makeSym({ id: "a" }), makeSym({ id: "b" }), makeSym({ id: "c" })],
      fpTokens: 0,
    });
    r.ports.runFirstPass = vi.fn().mockImplementation(async ({ symbol }) => {
      if (symbol.id === "b") throw parseError(40);
      return { candidates: [candidate({ symbolId: symbol.id })], totalTokens: 100 };
    });
    const res = await runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal });
    expect(r.state.failed).toBeNull();
    expect(r.state.completed?.id).toBe("scan-1");
    expect(res.symbolsScanned).toBe(2);
    expect(res.symbolsFailed).toBe(1);
    expect(res.candidatesKept).toBe(2);
    // The failed call still cost tokens — they count against the budget.
    expect(res.tokenSpend).toBe(240);
    expect(res.lastSymbolError).toMatch(/src\/foo\.ts::bar: no JSON object/);
  });

  it("resets the consecutive-failure streak after a parseable reply", async () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const r = recorder({ symbols: ids.map((id) => makeSym({ id })), firstPassTokens: 1 });
    // 4 failures, a success, 4 more failures: never 5 in a row.
    r.ports.runFirstPass = vi.fn().mockImplementation(async ({ symbol }) => {
      if (symbol.id !== "e") throw parseError(0);
      return { candidates: [], totalTokens: 1 };
    });
    const res = await runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal });
    expect(r.state.failed).toBeNull();
    expect(res.symbolsFailed).toBe(8);
    expect(res.symbolsScanned).toBe(1);
  });

  it("fails the scan after MAX_CONSECUTIVE_SYMBOL_FAILURES unparseable replies in a row", async () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    const r = recorder({ symbols: ids.map((id) => makeSym({ id })) });
    r.ports.runFirstPass = vi.fn().mockRejectedValue(parseError(10));
    await expect(
      runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal }),
    ).rejects.toThrow(/5 consecutive symbols/);
    expect(r.ports.runFirstPass).toHaveBeenCalledTimes(MAX_CONSECUTIVE_SYMBOL_FAILURES);
    expect(r.state.failed?.reason).toMatch(/no JSON object\/array found/);
    // Persisted on failure, so the UI does not read 0/0 symbols, 0 tokens.
    expect(r.state.failed?.summary).toMatchObject({
      totalSymbols: 7,
      symbolsScanned: 0,
      symbolsFailed: 5,
      tokenSpend: 50,
    });
  });

  it("still aborts on a non-parse error (provider down) — no silent per-symbol swallow", async () => {
    const r = recorder({ symbols: [makeSym({ id: "a" }), makeSym({ id: "b" })] });
    r.ports.runFirstPass = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal }),
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(r.ports.runFirstPass).toHaveBeenCalledTimes(1);
    expect(r.state.failed?.summary).toMatchObject({ totalSymbols: 2 });
  });

  it("persists the progress made before a failure", async () => {
    const r = recorder({ symbols: [makeSym({ id: "a" }), makeSym({ id: "b" })], fpTokens: 0 });
    r.ports.runFirstPass = vi.fn().mockImplementation(async ({ symbol }) => {
      if (symbol.id === "b") throw new Error("boom");
      return { candidates: [], totalTokens: 70 };
    });
    await expect(
      runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal }),
    ).rejects.toThrow(/boom/);
    expect(r.state.failed?.summary).toMatchObject({ symbolsScanned: 1, tokenSpend: 70 });
  });

  it("passes the scan to the FP filter so its calls can be metered against it", async () => {
    const r = recorder({});
    await runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal });
    expect((r.ports.runFpFilter as ReturnType<typeof vi.fn>).mock.calls[0][0].scan.id).toBe(
      "scan-1",
    );
  });

  // ---------------------------------------------------------------------------
  // #759 — a scan's progress survives a retry: resume, no re-billing, no
  // duplicate findings, and a timeout that names itself.
  // ---------------------------------------------------------------------------

  const abcd = () => ["a", "b", "c", "d"].map((id) => makeSym({ id, qualifiedName: `q::${id}` }));

  it("persists a resume cursor after every symbol, skipped ones included", async () => {
    const r = recorder({ symbols: abcd(), fpTokens: 0, firstPassTokens: 10 });
    r.ports.readSymbolBody = vi
      .fn()
      .mockImplementation(async (_s: ScanRecordSnapshot, sym: SymbolToScan) =>
        sym.id === "b" ? "   " : "body",
      );
    await runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal });
    expect(r.state.progress.map((p) => p.symbolCursor)).toEqual([1, 2, 3, 4]);
    expect(r.state.progress.at(-1)).toEqual({
      symbolCursor: 4,
      totalSymbols: 4,
      symbolsScanned: 3,
      tokenSpend: 30,
    });
  });

  it("resumes from the persisted cursor and never re-scans finished symbols", async () => {
    const r = recorder({
      scan: makeScan({
        budgetCapTokens: 10_000,
        resume: { symbolCursor: 2, symbolsScanned: 2, tokenSpend: 500 },
      }),
      symbols: abcd(),
      fpTokens: 0,
      firstPassTokens: 10,
    });
    const res = await runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal });
    const scanned = (r.ports.runFirstPass as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0].symbol.id,
    );
    expect(scanned).toEqual(["c", "d"]);
    // Counters carry across attempts instead of resetting to zero.
    expect(res.symbolsScanned).toBe(4);
    expect(res.tokenSpend).toBe(520);
    expect(r.state.completed?.summary).toMatchObject({ symbolsScanned: 4, tokenSpend: 520 });
  });

  it("drops the interrupted symbol's partial findings before re-scanning it", async () => {
    const r = recorder({
      scan: makeScan({ resume: { symbolCursor: 2, symbolsScanned: 2, tokenSpend: 0 } }),
      symbols: abcd(),
    });
    await runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal });
    expect(r.state.discarded).toEqual([{ scanId: "scan-1", symbolId: "c" }]);
    // Discarded before that symbol produced its fresh findings.
    const discardOrder = (r.ports.discardSymbolFindings as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const firstScanOrder = (r.ports.runFirstPass as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(discardOrder).toBeLessThan(firstScanOrder);
  });

  it("counts the tokens of earlier attempts against the budget", async () => {
    const r = recorder({
      scan: makeScan({
        budgetCapTokens: 1000,
        resume: { symbolCursor: 1, symbolsScanned: 1, tokenSpend: 1000 },
      }),
      symbols: abcd(),
    });
    const res = await runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal });
    expect(res.bailedOnBudget).toBe(true);
    expect(r.ports.runFirstPass).not.toHaveBeenCalled();
  });

  it("treats a cursor past the end (symbol list shrank) as nothing left to scan", async () => {
    const r = recorder({
      scan: makeScan({ resume: { symbolCursor: 9, symbolsScanned: 9, tokenSpend: 0 } }),
      symbols: abcd(),
    });
    const res = await runScan(r.ports, { scanId: "scan-1", signal: new AbortController().signal });
    expect(r.ports.runFirstPass).not.toHaveBeenCalled();
    expect(r.ports.discardSymbolFindings).not.toHaveBeenCalled();
    expect(r.state.completed?.summary).toMatchObject({ totalSymbols: 4 });
    expect(res.symbolsScanned).toBe(9);
  });

  it("names the task timeout, not the provider's 'Request was aborted', when an attempt times out", async () => {
    const ac = new AbortController();
    const r = recorder({ symbols: abcd(), fpTokens: 0 });
    r.ports.runFirstPass = vi.fn().mockImplementation(async ({ symbol }) => {
      if (symbol.id === "a") return { candidates: [], totalTokens: 10 };
      ac.abort(new TaskAbortError("timeout", "task timeout after 7200000ms"));
      throw new Error("anthropic chat failed (Error): Request was aborted.");
    });
    const err = await runScan(r.ports, { scanId: "scan-1", signal: ac.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toMatch(/Request was aborted/);
    expect(err.message).toMatch(/timed out \(task timeout after 120 min\)/);
    expect(err.message).toMatch(/1 of 4 symbols/);
    expect(err.message).toMatch(/resumes at symbol 2/);
    expect(r.state.failed?.reason).toBe(err.message);
    expect(r.state.completed).toBeNull();
  });

  it("says 'interrupted' with the reason for a non-timeout abort", async () => {
    const ac = new AbortController();
    ac.abort(new TaskAbortError("user", "cancelled by user"));
    const r = recorder({ symbols: abcd() });
    await expect(runScan(r.ports, { scanId: "scan-1", signal: ac.signal })).rejects.toThrow(
      /scan interrupted \(cancelled by user\)/,
    );
    expect(r.ports.runFirstPass).not.toHaveBeenCalled();
  });

  it("falls back to a generic reason when the abort carries none", async () => {
    const ac = new AbortController();
    ac.abort("stop");
    const r = recorder({ symbols: abcd() });
    await expect(runScan(r.ports, { scanId: "scan-1", signal: ac.signal })).rejects.toThrow(
      /scan interrupted \(aborted\)/,
    );
  });
});
