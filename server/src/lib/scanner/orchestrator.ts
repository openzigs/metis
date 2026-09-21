/**
 * Epic #708 / Issue #711 — Scan orchestrator.
 *
 * Owns the per-scan lifecycle:
 *   1.  Mark Scan running, snapshot `commitSha` from the repo connection.
 *   2.  Freshness gate — refuse to run if the CodeGraph for the repo was
 *       built against a different commit than the snapshot.
 *   3.  Enumerate `CodeSymbol` rows for the repo, filtered to MVP
 *       languages and (when scan.mode != "heuristic") to symbol kinds
 *       declared by at least one active rule in the project.
 *   4.  For each symbol: read its source slice, assemble context, run
 *       the first-pass scanner, then run the FP filter on every
 *       surviving candidate.
 *   5.  Insert `ScanFinding` rows; collisions on `(scanId, fingerprint)`
 *       become updates rather than duplicates.
 *   6.  Enforce a per-scan token budget (`Scan.budgetCapTokens`) and
 *       bail out gracefully if exceeded.
 *
 * I/O ports keep the orchestrator unit-testable without a database,
 * filesystem, or LLM in the loop.
 */
import type { CandidateFinding, Severity, TriageStatus } from "./types.js";
import { DEFAULT_SCAN_TOKEN_BUDGET, SCANNER_SUPPORTED_LANGUAGES } from "./types.js";
import { computeFingerprint } from "./validators.js";

export interface ScanRecordSnapshot {
  id: string;
  projectId: string;
  repoConnectionId: string;
  commitSha: string;
  mode: "rules" | "heuristic" | "both" | "spec";
  budgetCapTokens: number;
  createdById: string | null;
}

export interface SymbolToScan {
  id: string;
  qualifiedName: string;
  kind: string;
  language: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface ScanPersistedFinding {
  fingerprint: string;
  candidate: CandidateFinding;
  finalConfidence: number;
  rationales: string[];
  triageStatus: TriageStatus;
}

/** Run summary returned to the scheduler. */
export interface ScanRunResult {
  scanId: string;
  totalSymbols: number;
  symbolsScanned: number;
  candidatesProduced: number;
  candidatesKept: number;
  tokenSpend: number;
  bailedOnBudget: boolean;
  bailedOnFreshness: boolean;
  durationMs: number;
}

/**
 * Wire-up ports. Production wiring is in routes/scheduler boot.
 */
export interface ScannerPorts {
  loadScan(scanId: string): Promise<ScanRecordSnapshot | null>;
  /** Returns the SHA the CodeGraph was built against, or null when missing. */
  graphCommitSha(projectId: string, repoConnectionId: string): Promise<string | null>;
  /** Symbols for the repo, after applying language + rule-kind filter. */
  listSymbols(scan: ScanRecordSnapshot): Promise<SymbolToScan[]>;
  /** Read the symbol's source slice. */
  readSymbolBody(scan: ScanRecordSnapshot, symbol: SymbolToScan): Promise<string>;
  /** Rule-set instructions to feed the model. Empty string for heuristic-only. */
  ruleInstructions(scan: ScanRecordSnapshot): Promise<string>;
  /** First-pass scan. */
  runFirstPass(args: {
    scan: ScanRecordSnapshot;
    symbol: SymbolToScan;
    body: string;
    ruleInstructions: string;
    signal: AbortSignal;
  }): Promise<{ candidates: CandidateFinding[]; totalTokens: number }>;
  /** Second-pass FP filter. */
  runFpFilter(args: { candidate: CandidateFinding; body: string; signal: AbortSignal }): Promise<{
    keep: boolean;
    finalConfidence: number;
    rationales: string[];
    totalTokens: number;
  }>;
  /** Upsert a ScanFinding. Idempotent on (scanId, fingerprint). */
  upsertFinding(scanId: string, finding: ScanPersistedFinding): Promise<void>;
  /** Lifecycle. */
  markRunning(scanId: string, commitSha: string): Promise<void>;
  markFailed(scanId: string, reason: string): Promise<void>;
  markCompleted(scanId: string, summary: ScanRunResult): Promise<void>;
  /** Audit hook — best-effort. */
  audit(event: string, scanId: string, meta?: Record<string, unknown>): Promise<void>;
}

export interface RunScanInput {
  scanId: string;
  signal: AbortSignal;
  reportProgress?: (p: { step: string; pct?: number; current?: number; total?: number }) => void;
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

/** Filter candidates: drop info-tier and obviously empty findings. */
function shouldKeepCandidate(c: CandidateFinding): boolean {
  if (c.evidenceLines.length === 0) return false;
  if (!SEVERITY_ORDER.includes(c.severity)) return false;
  return true;
}

export async function runScan(ports: ScannerPorts, input: RunScanInput): Promise<ScanRunResult> {
  const t0 = Date.now();
  const report = input.reportProgress ?? (() => {});

  const scan = await ports.loadScan(input.scanId);
  if (!scan) throw new Error(`scan ${input.scanId} not found`);

  await ports.markRunning(scan.id, scan.commitSha);
  await ports.audit("scanner.scan.start", scan.id, {
    projectId: scan.projectId,
    repoConnectionId: scan.repoConnectionId,
    commitSha: scan.commitSha,
    mode: scan.mode,
  });

  const result: ScanRunResult = {
    scanId: scan.id,
    totalSymbols: 0,
    symbolsScanned: 0,
    candidatesProduced: 0,
    candidatesKept: 0,
    tokenSpend: 0,
    bailedOnBudget: false,
    bailedOnFreshness: false,
    durationMs: 0,
  };

  try {
    // Freshness gate.
    const graphSha = await ports.graphCommitSha(scan.projectId, scan.repoConnectionId);
    if (graphSha && graphSha !== scan.commitSha) {
      result.bailedOnFreshness = true;
      const reason = `code-graph commit ${graphSha} does not match scan commit ${scan.commitSha}`;
      await ports.markFailed(scan.id, reason);
      await ports.audit("scanner.scan.stale", scan.id, { graphSha, scanSha: scan.commitSha });
      result.durationMs = Date.now() - t0;
      return result;
    }

    const ruleInstructions = await ports.ruleInstructions(scan);
    const symbols = (await ports.listSymbols(scan)).filter((s) =>
      SCANNER_SUPPORTED_LANGUAGES.has(s.language.toLowerCase()),
    );
    result.totalSymbols = symbols.length;

    const budget = scan.budgetCapTokens || DEFAULT_SCAN_TOKEN_BUDGET;
    let tokenSpend = 0;
    let bailedOnBudget = false;

    for (let i = 0; i < symbols.length; i++) {
      if (input.signal.aborted) break;
      if (tokenSpend >= budget) {
        bailedOnBudget = true;
        break;
      }
      const sym = symbols[i];

      report({
        step: "scanner.scan.symbol",
        current: i + 1,
        total: symbols.length,
        pct: Math.round(((i + 1) / Math.max(1, symbols.length)) * 100),
      });

      let body: string;
      try {
        body = await ports.readSymbolBody(scan, sym);
      } catch {
        continue; // skip symbols whose source vanished mid-scan
      }
      if (!body || body.trim().length === 0) continue;

      const firstPass = await ports.runFirstPass({
        scan,
        symbol: sym,
        body,
        ruleInstructions,
        signal: input.signal,
      });
      tokenSpend += firstPass.totalTokens;
      result.symbolsScanned += 1;

      for (const candidate of firstPass.candidates) {
        result.candidatesProduced += 1;
        if (!shouldKeepCandidate(candidate)) continue;
        if (tokenSpend >= budget) {
          bailedOnBudget = true;
          break;
        }

        const fp = await ports.runFpFilter({ candidate, body, signal: input.signal });
        tokenSpend += fp.totalTokens;
        if (!fp.keep) continue;

        const fingerprint = computeFingerprint({
          projectId: scan.projectId,
          repoConnectionId: scan.repoConnectionId,
          qualifiedName: candidate.qualifiedName,
          ruleId: candidate.ruleId,
          title: candidate.title,
        });
        await ports.upsertFinding(scan.id, {
          fingerprint,
          candidate,
          finalConfidence: fp.finalConfidence,
          rationales: fp.rationales,
          triageStatus: "pending",
        });
        result.candidatesKept += 1;
      }
      if (bailedOnBudget) break;
    }

    result.tokenSpend = tokenSpend;
    result.bailedOnBudget = bailedOnBudget;
    result.durationMs = Date.now() - t0;
    await ports.markCompleted(scan.id, result);
    await ports.audit("scanner.scan.complete", scan.id, {
      symbolsScanned: result.symbolsScanned,
      candidatesKept: result.candidatesKept,
      tokenSpend: result.tokenSpend,
      bailedOnBudget: result.bailedOnBudget,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ports.markFailed(scan.id, message);
    await ports.audit("scanner.scan.failed", scan.id, { error: message });
    throw err;
  }
}
