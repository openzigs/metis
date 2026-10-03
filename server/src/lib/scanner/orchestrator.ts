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
 *   7.  #718 — a symbol whose model reply is not parseable JSON is skipped,
 *       not fatal; only {@link MAX_CONSECUTIVE_SYMBOL_FAILURES} in a row (a
 *       model that never answers in JSON) fail the scan. Any other error
 *       still aborts, and progress so far is persisted either way.
 *   8.  #759 — progress survives a retry. A resume cursor is persisted after
 *       every symbol, and the next attempt starts there with the earlier
 *       attempts' counters, so finished symbols are never re-scanned (or
 *       re-billed). The interrupted symbol's partial findings are dropped
 *       before it is scanned again. An abort never marks the scan completed:
 *       a user's cancel ends it `cancelled`; a timeout ends it `failed` and
 *       says so instead of surfacing the provider's "Request was aborted",
 *       promising a resume only when the queue will actually retry.
 *
 * I/O ports keep the orchestrator unit-testable without a database,
 * filesystem, or LLM in the loop.
 */
import type { CandidateFinding, Severity, TriageStatus } from "./types.js";
import { DEFAULT_SCAN_TOKEN_BUDGET, SCANNER_SUPPORTED_LANGUAGES } from "./types.js";
import { ScannerJsonParseError } from "../ai/json-llm-client.js";
import { computeFingerprint } from "./validators.js";
import { TaskAbortError } from "../scheduler/task-abort.js";

/** #759 — where an earlier attempt of this scan stopped. */
export interface ScanResumePoint {
  /** Index into the ordered symbol list of the next symbol to scan. */
  symbolCursor: number;
  symbolsScanned: number;
  tokenSpend: number;
}

/** #759 — persisted after every symbol so a retry can resume. */
export interface ScanProgress {
  symbolCursor: number;
  totalSymbols: number;
  symbolsScanned: number;
  tokenSpend: number;
}

export interface ScanRecordSnapshot {
  id: string;
  projectId: string;
  repoConnectionId: string;
  commitSha: string;
  mode: "rules" | "heuristic" | "both" | "spec";
  budgetCapTokens: number;
  createdById: string | null;
  /** #759 — absent (or cursor 0) on a first attempt. */
  resume?: ScanResumePoint;
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
  /** #718 — symbols skipped because the model's reply was not parseable JSON. */
  symbolsFailed: number;
  /** #718 — the most recent per-symbol failure, `qualifiedName: reason`. */
  lastSymbolError: string | null;
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
  runFpFilter(args: {
    scan: ScanRecordSnapshot;
    candidate: CandidateFinding;
    body: string;
    signal: AbortSignal;
  }): Promise<{
    keep: boolean;
    finalConfidence: number;
    rationales: string[];
    totalTokens: number;
  }>;
  /** Upsert a ScanFinding. Idempotent on (scanId, fingerprint). */
  upsertFinding(scanId: string, finding: ScanPersistedFinding): Promise<void>;
  /** #759 — persist the resume cursor and running counters. */
  recordProgress(scanId: string, progress: ScanProgress): Promise<void>;
  /**
   * #759 — drop this scan's untriaged findings for one symbol: the symbol an
   * earlier attempt was interrupted on, about to be scanned again.
   */
  discardSymbolFindings(scanId: string, symbolId: string): Promise<void>;
  /** Lifecycle. */
  markRunning(scanId: string, commitSha: string): Promise<void>;
  /** `summary` (#718) carries the progress made before the failure, when any. */
  markFailed(scanId: string, reason: string, summary?: ScanRunResult): Promise<void>;
  /** #759 — a user cancelled the scan; `summary` carries the progress made. */
  markCancelled(scanId: string, reason: string, summary: ScanRunResult): Promise<void>;
  markCompleted(scanId: string, summary: ScanRunResult): Promise<void>;
  /** Audit hook — best-effort. */
  audit(event: string, scanId: string, meta?: Record<string, unknown>): Promise<void>;
}

export interface RunScanInput {
  scanId: string;
  signal: AbortSignal;
  reportProgress?: (p: { step: string; pct?: number; current?: number; total?: number }) => void;
  /**
   * #759 — this run's place in the task's retry budget. A timed-out attempt
   * promises a resume only when `attempts < maxAttempts`; absent, no retry is
   * assumed, so the message never promises one that will not happen.
   */
  attempt?: { attempts: number; maxAttempts: number };
}

/**
 * #718 — unparseable replies in a row that fail the scan. One bad reply skips
 * one symbol; a run of them means the model is not answering in JSON at all,
 * and scanning thousands more symbols would only burn tokens to learn that.
 */
export const MAX_CONSECUTIVE_SYMBOL_FAILURES = 5;

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

/** Filter candidates: drop info-tier and obviously empty findings. */
function shouldKeepCandidate(c: CandidateFinding): boolean {
  if (c.evidenceLines.length === 0) return false;
  if (!SEVERITY_ORDER.includes(c.severity)) return false;
  return true;
}

/** "task timeout after 7200000ms" -> "task timeout after 120 min". */
function humaniseTimeout(message: string): string {
  return message.replace(/after (\d+)ms\b/, (_m, ms: string) => {
    const minutes = Math.round(Number(ms) / 60_000);
    return minutes >= 1 ? `after ${minutes} min` : `after ${ms}ms`;
  });
}

/**
 * #759 — the scan's error when its signal was aborted. A provider aborted
 * mid-call reports only "Request was aborted"; the user needs to know why the
 * attempt stopped, and whether anything will pick it up again. Only a timeout
 * with attempts left is retried by the queue: a user cancel is terminal, and
 * so is the last attempt.
 */
function interruptionMessage(
  signal: AbortSignal,
  result: ScanRunResult,
  cursor: number,
  attempt: RunScanInput["attempt"],
): string {
  const reason: unknown = signal.reason;
  const done = `after ${result.symbolsScanned} of ${result.totalSymbols} symbols`;
  if (reason instanceof TaskAbortError && reason.source === "user") {
    return `scan cancelled (${reason.message || "cancelled by user"}) ${done}`;
  }
  if (reason instanceof TaskAbortError && reason.source === "timeout") {
    const willRetry = attempt !== undefined && attempt.attempts < attempt.maxAttempts;
    const outcome = willRetry
      ? `progress is kept and a retry resumes at symbol ${cursor + 1}`
      : "no retries left";
    return `scan attempt timed out (${humaniseTimeout(reason.message)}) ${done}; ${outcome}`;
  }
  const why = reason instanceof Error && reason.message ? reason.message : "aborted";
  return `scan interrupted (${why}) ${done}`;
}

/** #759 — the abort was a user's cancel, which the queue treats as terminal. */
function isUserCancel(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason;
  return reason instanceof TaskAbortError && reason.source === "user";
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
    symbolsFailed: 0,
    lastSymbolError: null,
    candidatesProduced: 0,
    candidatesKept: 0,
    tokenSpend: 0,
    bailedOnBudget: false,
    bailedOnFreshness: false,
    durationMs: 0,
  };

  // #759 — index of the next symbol to scan; persisted after each one.
  let cursor = 0;

  try {
    // Freshness gate.
    const graphSha = await ports.graphCommitSha(scan.projectId, scan.repoConnectionId);
    if (graphSha && graphSha !== scan.commitSha) {
      result.bailedOnFreshness = true;
      const reason = `code-graph commit ${graphSha} does not match scan commit ${scan.commitSha}`;
      result.durationMs = Date.now() - t0;
      await ports.markFailed(scan.id, reason, result);
      await ports.audit("scanner.scan.stale", scan.id, { graphSha, scanSha: scan.commitSha });
      return result;
    }

    const ruleInstructions = await ports.ruleInstructions(scan);
    const symbols = (await ports.listSymbols(scan)).filter((s) =>
      SCANNER_SUPPORTED_LANGUAGES.has(s.language.toLowerCase()),
    );
    result.totalSymbols = symbols.length;

    // #759 — resume where an earlier attempt stopped, carrying its counters.
    const resume = scan.resume;
    if (resume) {
      cursor = resume.symbolCursor;
      result.symbolsScanned = resume.symbolsScanned;
      result.tokenSpend = resume.tokenSpend;
    }
    if (cursor < symbols.length) {
      // The symbol an interrupted attempt was on may have left findings
      // whose LLM-written titles will not fingerprint-match the rescan's.
      await ports.discardSymbolFindings(scan.id, symbols[cursor].id);
    }
    const advance = async (): Promise<void> => {
      cursor += 1;
      await ports.recordProgress(scan.id, {
        symbolCursor: cursor,
        totalSymbols: result.totalSymbols,
        symbolsScanned: result.symbolsScanned,
        tokenSpend: result.tokenSpend,
      });
    };

    const budget = scan.budgetCapTokens || DEFAULT_SCAN_TOKEN_BUDGET;
    let bailedOnBudget = false;
    let consecutiveFailures = 0;

    for (let i = cursor; i < symbols.length; i++) {
      if (input.signal.aborted) break;
      if (result.tokenSpend >= budget) {
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
        await advance();
        continue; // skip symbols whose source vanished mid-scan
      }
      if (!body || body.trim().length === 0) {
        await advance();
        continue;
      }

      let firstPass: Awaited<ReturnType<ScannerPorts["runFirstPass"]>>;
      try {
        firstPass = await ports.runFirstPass({
          scan,
          symbol: sym,
          body,
          ruleInstructions,
          signal: input.signal,
        });
      } catch (err) {
        if (!(err instanceof ScannerJsonParseError)) throw err;
        // The call ran and cost tokens; only its answer was unusable.
        result.tokenSpend += err.response.usage?.totalTokens ?? 0;
        result.symbolsFailed += 1;
        result.lastSymbolError = `${sym.qualifiedName}: ${err.message}`;
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_SYMBOL_FAILURES) {
          throw new Error(
            `model reply was not parseable JSON for ${consecutiveFailures} consecutive symbols; last: ${result.lastSymbolError}`,
          );
        }
        await advance();
        continue;
      }
      consecutiveFailures = 0;
      result.tokenSpend += firstPass.totalTokens;

      for (const candidate of firstPass.candidates) {
        result.candidatesProduced += 1;
        if (!shouldKeepCandidate(candidate)) continue;
        if (result.tokenSpend >= budget) {
          bailedOnBudget = true;
          break;
        }

        const fp = await ports.runFpFilter({ scan, candidate, body, signal: input.signal });
        result.tokenSpend += fp.totalTokens;
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
      // #759 — counted only once finished, in step with the cursor: an
      // attempt interrupted mid-symbol rescans it and must not count it twice.
      result.symbolsScanned += 1;
      await advance();
    }

    // #759 — an aborted attempt is not a completed scan.
    if (input.signal.aborted) throw new Error("aborted");

    result.bailedOnBudget = bailedOnBudget;
    result.durationMs = Date.now() - t0;
    await ports.markCompleted(scan.id, result);
    await ports.audit("scanner.scan.complete", scan.id, {
      symbolsScanned: result.symbolsScanned,
      candidatesKept: result.candidatesKept,
      tokenSpend: result.tokenSpend,
      bailedOnBudget: result.bailedOnBudget,
      symbolsFailed: result.symbolsFailed,
    });
    return result;
  } catch (err) {
    const aborted = input.signal.aborted;
    const message = aborted
      ? interruptionMessage(input.signal, result, cursor, input.attempt)
      : err instanceof Error
        ? err.message
        : String(err);
    result.durationMs = Date.now() - t0;
    if (aborted && isUserCancel(input.signal)) {
      await ports.markCancelled(scan.id, message, result);
      await ports.audit("scanner.scan.cancelled", scan.id, { error: message });
    } else {
      await ports.markFailed(scan.id, message, result);
      await ports.audit("scanner.scan.failed", scan.id, { error: message });
    }
    // The queue records the thrown message on the task; make it the same one.
    throw aborted ? new Error(message, { cause: err }) : err;
  }
}
