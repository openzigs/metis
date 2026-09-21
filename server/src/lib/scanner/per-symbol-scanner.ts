/**
 * Epic #708 / Issue #712 — Per-symbol first-pass scanner.
 *
 * Sends the assembled context to the Haiku tier and parses its
 * JSON-formatted findings array. Each candidate is validated:
 *   • required fields present + types correct
 *   • severity in closed vocab
 *   • confidence ∈ [0,1]
 *   • evidence_lines intersected with the symbol's actual line range
 *
 * Findings that lose all evidence lines are discarded — we won't ship a
 * bug report we can't anchor in source.
 */
import type { AIProvider } from "../ai/types.js";
import { callJsonLlm } from "./llm-client.js";
import {
  type AssembledContext,
  type AssembledSymbol,
  assembleContext,
} from "./context-assembler.js";
import { validateEvidenceLines } from "./validators.js";
import { SEVERITY_VALUES, type CandidateFinding, type Severity } from "./types.js";

export interface ScanSymbolInput {
  symbol: AssembledSymbol;
  /** Pre-assembled context. If omitted, callers should use `scanSymbol` directly. */
  context?: AssembledContext;
  /** Rule-set instructions (only used when `context` is omitted). */
  ruleInstructions?: string;
  /** Optional model override. */
  modelOverride?: string;
  /** Cancellation. */
  signal?: AbortSignal;
}

export interface ScanSymbolResult {
  candidates: CandidateFinding[];
  /** Raw model output. */
  raw: string;
  /** Tokens consumed by this call. */
  totalTokens: number;
}

interface ModelFinding {
  ruleId?: string | null;
  title?: string;
  body?: string;
  severity?: string;
  category?: string;
  evidence_lines?: number[];
  confidence?: number;
}

function isSeverity(v: string): v is Severity {
  return (SEVERITY_VALUES as readonly string[]).includes(v);
}

export function parseCandidates(
  raw: { findings?: unknown } | undefined,
  symbol: AssembledSymbol,
): CandidateFinding[] {
  const findings = Array.isArray(raw?.findings) ? raw!.findings! : [];
  const out: CandidateFinding[] = [];
  for (const f of findings as ModelFinding[]) {
    if (!f || typeof f !== "object") continue;
    const title = typeof f.title === "string" ? f.title.trim().slice(0, 200) : "";
    const body = typeof f.body === "string" ? f.body.trim().slice(0, 4000) : "";
    if (!title || !body) continue;

    const severity =
      typeof f.severity === "string" && isSeverity(f.severity.toLowerCase())
        ? (f.severity.toLowerCase() as Severity)
        : "medium";
    const category =
      typeof f.category === "string" && f.category.trim().length > 0
        ? f.category.trim().slice(0, 64)
        : "correctness";

    const reportedLines = Array.isArray(f.evidence_lines) ? f.evidence_lines : [];
    const evidence = validateEvidenceLines(
      reportedLines.filter((n): n is number => typeof n === "number"),
      symbol.startLine,
      symbol.endLine,
    );
    if (evidence.length === 0) continue; // drop hallucinations

    const rawConf =
      typeof f.confidence === "number" && Number.isFinite(f.confidence) ? f.confidence : 0.5;
    const confidence = Math.max(0, Math.min(1, rawConf));

    out.push({
      symbolId: symbol.symbolId,
      qualifiedName: symbol.qualifiedName,
      filePath: symbol.filePath,
      ruleId: typeof f.ruleId === "string" && f.ruleId.length > 0 ? f.ruleId : null,
      title,
      body,
      severity,
      category,
      evidenceLines: evidence,
      confidence,
    });
  }
  return out;
}

export async function scanSymbol(
  provider: AIProvider,
  input: ScanSymbolInput,
): Promise<ScanSymbolResult> {
  const ctx =
    input.context ??
    assembleContext({
      symbol: input.symbol,
      neighbours: [],
      ragHits: [],
      ruleInstructions: input.ruleInstructions ?? "",
    });
  const { parsed, raw, response } = await callJsonLlm<{ findings?: unknown }>(provider, {
    systemPrompt: ctx.systemPrompt,
    userPrompt: ctx.userPrompt,
    modelOverride: input.modelOverride,
    maxTokens: 2048,
    promptCaching: true,
    signal: input.signal,
  });
  return {
    candidates: parseCandidates(parsed, input.symbol),
    raw,
    totalTokens: response.usage?.totalTokens ?? 0,
  };
}
