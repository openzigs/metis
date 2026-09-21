/**
 * Single-agent runner for the multi-agent analysis pipeline (Phase 7 / #55).
 *
 * Each invocation:
 *   1. retrieves project-scoped context from the RAG knowledge service
 *   2. builds a delimited, injection-resistant prompt
 *   3. sends a single chat completion to the configured AIProvider
 *   4. validates the JSON response against the shared zod schema
 *   5. returns a typed `AgentRunResult` with token usage rolled up
 *
 * The runner is intentionally stateless. A fresh AbortController wires the
 * cancellation signal through to the provider so a cancelled analysis stops
 * burning tokens immediately.
 */
import {
  FALLBACK_FINDING_CATEGORY,
  FINDING_CATEGORIES,
  agentOutputSchema,
  documentAgentOutputSchema,
  isDocumentCitation,
  matchFindingCategory,
  type AgentOutput,
  type AnalysisAgentKey,
  type AnalysisSpecialistAgentKey,
  type Citation,
} from "@metis/shared";
import { supportsResponseFormat } from "../ai/capabilities.js";
// #1221 owns the single table of model output ceilings. The clamp lives there
// because it is not analysis-specific; only its application is.
import {
  clampToModelOutputCeiling,
  lookupModelMaxOutputTokens,
} from "../ai/model-output-limits.js";
import type { AIProvider, ChatMessage, TokenUsage } from "../ai/types.js";
import { getConfigService } from "../config/config-service.js";
import { ConfigValidationError } from "../config/errors.js";
// #1226 owns the single table of provider stop signals that mean "the OUTPUT
// cap fired". Imported rather than re-listed: a second copy would drift, and
// the module is a dependency-free leaf despite living under `docs-gen/`.
import { isTruncationFinishReason } from "../docs-gen/truncation.js";
import { createChildLogger } from "../logger.js";
import { DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS } from "./agent-loop.js";
import { buildSpecialistPrompt } from "./prompts.js";
import { responseFormatForAgent } from "./structured-output-schemas.js";

const log = createChildLogger("analysis-agent-runner");

export interface RetrievalContextChunk {
  documentId: string;
  chunkIndex: number;
  filename: string;
  text: string;
  score?: number;
  /**
   * #729 (Epic #725) — code-graph symbol provenance. Present only on fused
   * symbol chunks (`source === "code-graph"`, synthetic `documentId` prefixed
   * `code-graph:`); document-RAG chunks leave all of these unset. Epic #726
   * citations rely on `filePath:startLine-endLine`.
   */
  source?: "code-graph";
  symbolId?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
}

export interface AgentRunInput {
  agentKey: AnalysisSpecialistAgentKey;
  projectName: string;
  projectDescription: string;
  retrieved: RetrievalContextChunk[];
  signal?: AbortSignal;
  model?: string;
  extraInstructions?: string;
  /**
   * #824 (Epic #820 Phase 1) — the deterministic AFFECTED SCHEMA block (#823),
   * consumed ONLY by the `database` agent (Sally). Empty/undefined ⇒ omitted.
   */
  affectedSchema?: string;
}

export interface AgentRunResult {
  agentKey: AnalysisAgentKey;
  output: AgentOutput;
  usage: TokenUsage;
  durationMs: number;
}

const DEFAULT_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

const formatRetrievedContext = (chunks: RetrievalContextChunk[]): string => {
  if (chunks.length === 0) return "";
  return chunks
    .map(
      (c, i) =>
        `[${i + 1}] documentId=${c.documentId} chunk=${c.chunkIndex} file=${c.filename}\n${c.text}`,
    )
    .join("\n---\n");
};

/**
 * Build the citation list keyed off whatever citations the model returned.
 * The model gets `documentId`/`chunkIndex` directly from the retrieved
 * context; we additionally enrich citations whose documentId+chunkIndex
 * matches a chunk we provided so the UI can show the resolved filename even
 * when the model omitted it.
 */
export function enrichCitations(
  citations: Citation[],
  retrieved: RetrievalContextChunk[],
): Citation[] {
  const byKey = new Map<string, RetrievalContextChunk>();
  for (const c of retrieved) {
    byKey.set(`${c.documentId}#${c.chunkIndex}`, c);
  }
  return citations.map((c) => {
    // #734 — code citations carry no documentId/chunkIndex; leave them for the
    // dedicated code-citation grounding pass and never key them by documentId.
    if (!isDocumentCitation(c)) return c;
    const key = `${c.documentId}#${c.chunkIndex}`;
    const match = byKey.get(key);
    if (!match) return c;
    return {
      ...c,
      filename: c.filename ?? match.filename,
      snippet: c.snippet ?? match.text.slice(0, 240),
      score: c.score ?? match.score,
    };
  });
}

/**
 * Strip Markdown code fences and locate the first valid JSON object in the
 * model's response. Models occasionally pad JSON with prose despite explicit
 * instructions, so we accept anything that contains a parseable object.
 */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  // Quick path \u2014 the model obeyed.
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }
  // Strip ```json ... ``` style fences.
  //
  // #1253 — there is deliberately NO `\s*` after the opening fence. A greedy
  // `\s*` in front of the lazy `[\s\S]*?` is QUADRATIC when the closing fence
  // is absent: `\s*` can end at any of the `w` positions in the whitespace run,
  // and each one restarts a lazy scan that walks to end-of-input hunting a ```
  // that never comes. Measured at 200 KB: 1,503 ms as filed, 0.06 ms without
  // it, scaling 4x per doubling. That is synchronous event-loop work over
  // untrusted model output on every path that reaches this shared parser —
  // `agentic-degradation.ts:74` runs it on exactly the truncated text that
  // produces this shape.
  //
  // Group 1 now swallows the leading whitespace instead. Note that unlike
  // `parseToolCall` (#1244), only ONE of the two uses of the capture trims: the
  // guard below reads it raw. So on a fence body that is non-empty but all
  // whitespace the guard flips from falsy to truthy — and then `inner` trims
  // back to "", `"".startsWith("{")` is false, and both versions fall through
  // to the identical brute-force branch. The extracted value and the thrown
  // error are pinned differentially against the old pattern in
  // `agent-runner-fence-redos.test.ts`.
  const fenceMatch = trimmed.match(/```(?:json)?([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1]) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith("{")) return JSON.parse(inner);
  }
  // Brute-force \u2014 grab the substring from the first `{` to the matching `}`.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error("Model response did not contain a JSON object");
}

/**
 * #1218 — a repair echoes its input back verbatim, so its OUTPUT cap must clear
 * the cap that bounded that input, plus room for the escaping a syntax fix adds
 * (`\n` for a raw newline, `\"` for a bare quote) and for the brackets it closes.
 */
export const REPAIR_OUTPUT_HEADROOM = 1.25;

/**
 * Scale a repair's OUTPUT cap off the cap that bounded the text it must echo,
 * then hold the result at the active model's ceiling (#1221).
 *
 * The clamp has to be applied HERE and not only to the base value, because the
 * repair is the only request on this path that asks for MORE than the operator
 * configured: 16384 × 1.25 = 20480. Guarding the base alone would leave the
 * salvage call — the one that exists to recover a failing run — taking the 400.
 *
 * Note what this deliberately does NOT do: shrink the base value to
 * `ceiling / 1.25` so the repair always gets its full 1.25×. That would spend
 * 20% of the model's output capacity on every normal answer to buy headroom the
 * model cannot grant anyway once the base sits at the ceiling. When base ==
 * ceiling the repair simply gets the ceiling, which is the largest request that
 * can succeed; a payload that long may still truncate on repair, and that is a
 * physical limit of the model rather than something a multiplier can fix.
 *
 * Silent by design: {@link resolveFinalAnswerMaxOutputTokens} has already
 * warned about this model and value, and a second voice per call would bury it.
 *
 * @param model active model id — omit only when it genuinely cannot be known.
 */
export function repairMaxOutputTokens(inputCap: number, model?: string | null): number {
  const scaled = Math.ceil(inputCap * REPAIR_OUTPUT_HEADROOM);
  const ceiling = lookupModelMaxOutputTokens(model);
  return ceiling === null ? scaled : Math.min(scaled, ceiling);
}

/**
 * Default repair OUTPUT cap: sized for the largest payload that can reach
 * repair, which is a final-answer retry bounded by
 * {@link DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS}.
 */
export const DEFAULT_REPAIR_MAX_OUTPUT_TOKENS = repairMaxOutputTokens(
  DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS,
);

/** The knob this module reads. Exported so the startup check can name it. */
export const FINAL_ANSWER_MAX_OUTPUT_TOKENS_KEY = "ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS";

/**
 * Read the configured cap, rejecting a value the registry's own schema says is
 * invalid (#1221).
 *
 * `ConfigService.getNumber` was doing this with `Number.parseInt` and a silent
 * fallback, which let three bad values through: `"0"` and `"-5"` were returned
 * verbatim and became a `maxTokens` the provider rejects at request time, and
 * `"16384abc"` truncated to a number that looked deliberate. Validating through
 * `getKeyDef(...).schema` — already `z.coerce.number().int().positive()` in the
 * registry — means there is ONE statement of what a legal value is, applied on
 * both the env path and the runtime-config `set()` path, rather than a second
 * hand-written copy here that could drift from it.
 */
function readConfiguredFinalAnswerMaxOutputTokens(): number {
  const cfg = getConfigService();
  const raw = cfg.get(FINAL_ANSWER_MAX_OUTPUT_TOKENS_KEY);
  if (raw === undefined) return DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS;

  const def = cfg.getKeyDef(FINAL_ANSWER_MAX_OUTPUT_TOKENS_KEY);
  const parsed = def?.schema.safeParse(raw);
  if (!parsed?.success) {
    throw new ConfigValidationError(
      FINAL_ANSWER_MAX_OUTPUT_TOKENS_KEY,
      parsed?.error.flatten() ?? `no registry entry for ${FINAL_ANSWER_MAX_OUTPUT_TOKENS_KEY}`,
    );
  }
  // Narrowing, not a second rule: the schema decides validity, this only
  // establishes that what it handed back is the number the caller expects.
  const value: unknown = parsed.data;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigValidationError(
      FINAL_ANSWER_MAX_OUTPUT_TOKENS_KEY,
      `schema produced a non-numeric value for ${FINAL_ANSWER_MAX_OUTPUT_TOKENS_KEY}`,
    );
  }
  return value;
}

/**
 * Startup gate for {@link FINAL_ANSWER_MAX_OUTPUT_TOKENS_KEY} (#1221).
 *
 * Called from `server/src/index.ts` so a non-positive or non-numeric value is
 * rejected at boot — where it reads as a config error — instead of surfacing
 * hours later as a provider rejection on the degraded salvage pass, which is
 * the one place an operator will not think to look. Throws
 * `ConfigValidationError`; the caller decides whether that is fatal.
 */
export function assertFinalAnswerMaxOutputTokensValid(): void {
  readConfiguredFinalAnswerMaxOutputTokens();
}

/**
 * #1218/#1224 — the OUTPUT cap for one complete agent answer, shared by the
 * agentic final-answer retry (via the orchestrator) and by the single-shot
 * {@link runAgent} call. Deliberately ONE knob for both: they emit the same
 * payload against the same schema, so a model whose ceiling forces the retry
 * down to 8192 forces the single-shot call down with it.
 *
 * Configurable because a hardcoded 16384 is rejected outright by a model whose
 * output ceiling is 8192, which would turn a previously-working call into a 400.
 *
 * #1221 — configurable, but no longer unguarded. The value is validated at read
 * (see {@link assertFinalAnswerMaxOutputTokensValid}) and then held at `model`'s
 * verified output ceiling, so an operator who sets it too high gets a clamp and
 * a warning rather than a provider rejection on the salvage pass. Pass the model
 * the request will actually run on — `input.model ?? provider.model` — because
 * an omitted id cannot be checked against anything and is reported as such.
 *
 * Lives here rather than in `orchestrator.ts` so `runAgent` can reach it: the
 * dependency runs orchestrator → agent-runner, and importing back the other way
 * would be a cycle. The exported NAME and MODULE are load-bearing — #1223
 * imports this symbol; the `model` parameter is optional so that call site keeps
 * compiling.
 */
export function resolveFinalAnswerMaxOutputTokens(
  model?: string | null,
  /**
   * #1257 — the provider the request will run on. BOTH consumers of this cap
   * (`runAgent` and the agent loop's final-answer retry) call `provider.chat`,
   * which is non-streaming, so the SDK's client-side bound applies to both. It
   * is a parameter rather than an assumption because the bound belongs to the
   * client, not the model: Bedrock reaches the same models with no such limit.
   */
  providerKey?: string | null,
): number {
  return clampToModelOutputCeiling(readConfiguredFinalAnswerMaxOutputTokens(), model, undefined, {
    knob: FINAL_ANSWER_MAX_OUTPUT_TOKENS_KEY,
    ...(providerKey != null ? { nonStreamingProviderKey: providerKey } : {}),
  }).value;
}

/**
 * ONE bounded attempt to recover a structurally invalid agent response.
 *
 * The specialists occasionally emit JSON whose brackets diverge a few thousand
 * characters in (observed repeatedly on the `database` agent against a
 * 641-table Oracle schema, at `contentLength` well under the token cap — so
 * malformed, not truncated). Prompting does not prevent it, and neither does
 * `response_format`: some gateways ACCEPT the schema and silently decline to
 * constrain decoding.
 *
 * Rather than discard a completed investigation, hand the model back its OWN
 * output and ask for valid JSON. The repair prompt deliberately carries no
 * project context, no retrieved chunks and no schema guidance — it is a pure
 * syntax fix, so it cannot introduce ungrounded content that was not already in
 * the agent's answer, and Zod still validates the result downstream.
 *
 * Returns the parsed object, or `null` when the repair also fails — the caller
 * then reports the ORIGINAL parse error, never the repair's.
 */
export async function repairAgentJson(
  provider: AIProvider,
  malformed: string,
  originalError: Error,
  input: Pick<AgentRunInput, "agentKey" | "model" | "signal"> & {
    /** OUTPUT cap for the repair call. Defaults to {@link DEFAULT_REPAIR_MAX_OUTPUT_TOKENS}. */
    maxOutputTokens?: number;
  },
): Promise<unknown> {
  const started = Date.now();
  try {
    const repair = await provider.chat(
      [
        {
          role: "user",
          content:
            "The following text was meant to be a single JSON object but does not parse:\n" +
            `${originalError.message}\n\n` +
            "Return the SAME content as valid JSON. Do not add, remove, summarise or " +
            "reword any field — fix only the syntax (unbalanced brackets, unescaped " +
            "quotes or newlines inside strings). Reply with the JSON object and nothing else.\n\n" +
            malformed,
        },
      ],
      {
        systemMessage: "You repair malformed JSON. You output JSON only.",
        model: input.model,
        signal: input.signal,
        // #1218 — repair is an ECHO: it must emit the whole payload back. Left
        // unset it inherited `OpenAICompatibleProvider.defaultMaxTokens = 4096`
        // and truncated its own output, reproducing the very #1217 D3 defect it
        // exists to undo whenever the input was a cap-truncated payload.
        maxTokens: input.maxOutputTokens ?? DEFAULT_REPAIR_MAX_OUTPUT_TOKENS,
      },
    );
    const parsed = extractJsonObject(repair.content);
    log.warn("Agent JSON repaired on retry", {
      agentKey: input.agentKey,
      originalError: originalError.message,
      repairDurationMs: Date.now() - started,
    });
    return parsed;
  } catch (repairErr) {
    log.error("Agent JSON repair failed", {
      agentKey: input.agentKey,
      originalError: originalError.message,
      repairError: (repairErr as Error).message,
    });
    return null;
  }
}

/**
 * Hard caps mirrored from `agentOutputSchema` / `agentFindingPayloadSchema` in
 * `@metis/shared`. Kept as an explicit table rather than derived from the Zod
 * schema because introspecting `_def.checks` across Zod versions is fragile,
 * and a silent drift here only ever costs a few truncated characters.
 */
const OUTPUT_CAPS = {
  summary: 2048,
  note: 512,
  notes: 20,
  findings: 50,
  title: 255,
  body: 4096,
  tag: 64,
  tags: 16,
  requirementId: 128,
} as const;

/** Truncate to `max`; leave non-strings alone so Zod still reports the type error. */
function clampString(value: unknown, max: number): unknown {
  return typeof value === "string" && value.length > max ? value.slice(0, max) : value;
}

/** Clamp each entry, drop blanks (every list here is `min(1)`), cap the length. */
function clampStringArray(value: unknown, itemMax: number, arrayMax: number): unknown {
  if (!Array.isArray(value)) return value;
  return value
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .map((item) => item.slice(0, itemMax))
    .slice(0, arrayMax);
}

/**
 * #1230 — clamp model-authored strings to their schema bounds BEFORE validating.
 *
 * `runAgent` already spends a whole repair call rather than discard an answer
 * that is merely malformed JSON. Well-formed JSON that overruns a single
 * `maxLength` was treated far more harshly: `schema.parse` threw, the agent was
 * recorded `failed`, and every finding it had produced was lost. In production
 * the document specialist lost a complete investigation to
 * `{"code":"too_big","maximum":512,"path":["notes",0]}` — an over-long NOTE,
 * the least load-bearing field in the payload.
 *
 * Truncation is the right trade because these caps are storage hygiene, not
 * correctness: METIS is recall-first, and a dropped finding is invisible to the
 * user (the #1101 lesson). This only ever shortens values — it cannot
 * manufacture a field, relax an enum, or turn invalid output into valid output,
 * so genuinely malformed payloads still fail validation.
 */
export function clampAgentOutputStrings(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const obj = parsed as Record<string, unknown>;

  obj.summary = clampString(obj.summary, OUTPUT_CAPS.summary);
  obj.notes = clampStringArray(obj.notes, OUTPUT_CAPS.note, OUTPUT_CAPS.notes);

  if (Array.isArray(obj.findings)) {
    obj.findings = obj.findings.slice(0, OUTPUT_CAPS.findings).map((finding) => {
      if (finding === null || typeof finding !== "object" || Array.isArray(finding)) return finding;
      const f = finding as Record<string, unknown>;
      f.title = clampString(f.title, OUTPUT_CAPS.title);
      f.body = clampString(f.body, OUTPUT_CAPS.body);
      f.requirementId = clampString(f.requirementId, OUTPUT_CAPS.requirementId);
      if (Array.isArray(f.tags))
        f.tags = clampStringArray(f.tags, OUTPUT_CAPS.tag, OUTPUT_CAPS.tags);
      return f;
    });
  }

  return obj;
}

/** #1222 — one finding whose model-authored `category` was not a real member. */
export interface CoercedFindingCategory {
  /** Position in the model's own `findings` array, for correlating with the payload. */
  index: number;
  /** What the model actually wrote, truncated for the log line. */
  original: unknown;
}

/**
 * Cap on the raw category carried into a log line. The value is model-authored,
 * so it is not bounded by anything — a single confused finding could otherwise
 * put its whole body in the logs.
 */
const LOGGED_CATEGORY_MAX = 64;

/**
 * Cap on how many coerced categories are NAMED in one log line. `count` still
 * reports the true total.
 *
 * This runs BEFORE `clampAgentOutputStrings`, so the `findings` array has not
 * yet been cut to its schema maximum of 50 — the list is bounded only by what
 * the model chose to emit. Distinct values are what diagnose the drift, and
 * they run out long before the findings do.
 */
const LOGGED_CATEGORY_SAMPLE = 10;

/**
 * #1222 — report every finding whose `category` will be rewritten to
 * {@link FALLBACK_FINDING_CATEGORY} by `agentFindingPayloadSchema`.
 *
 * The coercion itself deliberately lives in the shared schema, because there
 * are five parse sites for model-authored findings and only one of them is
 * here. This function exists so the rewrite is not SILENT: #1228's core defect
 * was exactly a silent no-op, and a coercion nobody can see is how you stop
 * learning that the prompt's category guidance needs work.
 *
 * A value that merely needed case or whitespace normalising (`"Security"`) is
 * NOT reported — no fidelity was lost, so it is not drift.
 *
 * Pure and total: any input shape returns a list, never throws. Zod still owns
 * rejecting the payloads this walks past.
 */
export function collectCoercedFindingCategories(parsed: unknown): CoercedFindingCategory[] {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const findings = (parsed as Record<string, unknown>).findings;
  if (!Array.isArray(findings)) return [];

  const coerced: CoercedFindingCategory[] = [];
  findings.forEach((finding, index) => {
    if (finding === null || typeof finding !== "object" || Array.isArray(finding)) return;
    const original = (finding as Record<string, unknown>).category;
    if (matchFindingCategory(original) !== null) return;
    coerced.push({
      index,
      original: typeof original === "string" ? original.slice(0, LOGGED_CATEGORY_MAX) : original,
    });
  });
  return coerced;
}

export async function runAgent(
  provider: AIProvider,
  input: AgentRunInput,
): Promise<AgentRunResult> {
  const start = Date.now();
  if (input.signal?.aborted) {
    throw new DOMException("Aborted before start", "AbortError");
  }
  const { systemMessage, userMessage } = buildSpecialistPrompt({
    agentKey: input.agentKey,
    projectName: input.projectName,
    projectDescription: input.projectDescription,
    retrievedContext: formatRetrievedContext(input.retrieved),
    extraInstructions: input.extraInstructions,
    affectedSchema: input.affectedSchema,
  });
  const messages: ChatMessage[] = [{ role: "user", content: userMessage }];

  log.info("Agent run starting", {
    agentKey: input.agentKey,
    retrievedChunks: input.retrieved.length,
  });

  // Constrain decoding when the runtime supports it so a long, table-heavy
  // answer cannot come back as structurally invalid JSON and discard the whole
  // investigation. Runtimes that reject the field degrade gracefully inside the
  // provider (StructuredOutputRejectedError -> one retry without it), landing
  // back on the unchanged free-form `extractJsonObject` path below.
  const responseFormat = supportsResponseFormat(provider)
    ? responseFormatForAgent(input.agentKey)
    : undefined;

  // #1224 — an EXPLICIT output cap. Left unset this inherited
  // `BedrockDirectProvider.defaultMaxTokens = 4096` via
  // `opts.maxTokens ?? this.defaultMaxTokens`, so a full findings payload came
  // back cut off with nothing at the call site to show for it. Same knob as the
  // agentic final-answer retry (#1218) — one agent answer, one cap.
  //
  // #1221 — resolved against the model this request will run on, so the cap is
  // clamped to that model's real ceiling. `provider.model` is the fallback
  // precisely because that is what the adapter would use when `input.model` is
  // unset: checking the cap against a model the request will not use is worse
  // than not checking it, because it reads as verified.
  const activeModel = input.model ?? provider.model;
  // #1257 — `provider.chat` is NON-streaming, so the cap is additionally bounded
  // by what the Anthropic SDK will agree to send (21,333). #1221's model ceiling
  // does not cover this: claude-sonnet-5 is listed at 128,000.
  const maxOutputTokens = resolveFinalAnswerMaxOutputTokens(activeModel, provider.key);

  const response = await provider.chat(messages, {
    systemMessage,
    model: input.model,
    signal: input.signal,
    maxTokens: maxOutputTokens,
    ...(responseFormat ? { responseFormat } : {}),
  });

  // #1224 — surface the provider's own stop signal. Until this landed, a
  // cap-truncated answer and a model that simply emitted broken JSON were
  // indistinguishable in the logs, and the truncation was diagnosed by
  // guesswork. `finishReason` is absent on providers that do not report one, so
  // "unknown" means no evidence either way — never "not truncated".
  const capTruncated = isTruncationFinishReason(response.finishReason);
  if (capTruncated) {
    log.warn("Agent response hit the output cap", {
      agentKey: input.agentKey,
      finishReason: response.finishReason,
      maxOutputTokens,
      contentLength: response.content.length,
      model: response.model,
      hint: "Raise ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS, or lower it if the model rejects the request outright.",
    });
  }

  let parsed: unknown;
  try {
    parsed = extractJsonObject(response.content);
  } catch (err) {
    log.error("Agent non-JSON response", {
      agentKey: input.agentKey,
      contentLength: response.content.length,
      // The defect is a structural divergence somewhere in the MIDDLE of the
      // JSON, so a 500-char head is useless for diagnosis. Log a window around
      // the reported parse offset instead.
      parseError: (err as Error).message,
      // #1224 — the two hypotheses this log has to separate.
      finishReason: response.finishReason ?? "unknown",
      capTruncated,
      maxOutputTokens,
      contentWindow: (() => {
        const at = Number(/position (\d+)/.exec((err as Error).message)?.[1] ?? 0);
        return response.content.slice(Math.max(0, at - 600), at + 600);
      })(),
      provider: response.provider,
      model: response.model,
    });
    // ONE bounded repair attempt before discarding a completed investigation.
    // Neither prompting nor `response_format` reliably prevents this: the
    // bedrock-access-gateway ACCEPTS the schema and silently declines to
    // constrain decoding, so long, table-heavy answers still come back with an
    // unbalanced bracket a few thousand characters in. Re-parsing is far
    // cheaper than re-running the agent, and the repair prompt carries no
    // project context — only the model's own malformed text.
    //
    // #1224 — the repair ECHOES this payload back, so its own cap must clear
    // the cap that bounded the payload. Scaled off the resolved value rather
    // than the default, or lowering the cap for an 8192-ceiling model would
    // leave the repair asking that same model for 20480 and get a hard 400.
    //
    // #1221 — and clamped to the same model's ceiling, because this is the one
    // call that asks for MORE than the operator configured (×1.25).
    const repaired = await repairAgentJson(provider, response.content, err as Error, {
      ...input,
      maxOutputTokens: repairMaxOutputTokens(maxOutputTokens, activeModel),
    });
    if (repaired === null) {
      throw new Error(
        `Agent ${input.agentKey} returned non-JSON output: ${(err as Error).message}` +
          // Carried into the persisted agent-failure reason on purpose: this is
          // the one place a live diagnosis reaches someone reading the run
          // rather than the server logs.
          ` (finishReason=${response.finishReason ?? "unknown"}${capTruncated ? ", output-cap truncation" : ""})`,
      );
    }
    parsed = repaired;
  }
  // Force the agentKey field to match the runner's input \u2014 the model is
  // welcome to omit it; we never trust it to *change* it.
  if (parsed && typeof parsed === "object") {
    (parsed as Record<string, unknown>).agentKey = input.agentKey;
  }
  // #750 — the DOCUMENT agent is validated against a superset schema that
  // RETAINS its extracted `requirements` array; every other agent keeps the
  // strict base schema. Without this, Zod's default strip drops `requirements`,
  // extraction always yields `[]`, and the code agent never leaves single-shot.
  const schema = input.agentKey === "document" ? documentAgentOutputSchema : agentOutputSchema;

  // #1222 — the rewrite happens inside the schema; the WARN happens here,
  // because this is the only place where a logger and `agentKey` are both in
  // scope. Read before parsing: the parse is what erases the original value.
  const coercedCategories = collectCoercedFindingCategories(parsed);
  if (coercedCategories.length > 0) {
    log.warn("Agent emitted finding categories outside the enum", {
      agentKey: input.agentKey,
      count: coercedCategories.length,
      coercedTo: FALLBACK_FINDING_CATEGORY,
      // `JSON.stringify` rather than raw interpolation: the value is
      // model-authored, and stringifying escapes the newlines and quotes a
      // forged log line would need.
      originals: coercedCategories
        .slice(0, LOGGED_CATEGORY_SAMPLE)
        .map((c) => `findings[${c.index}]=${JSON.stringify(c.original) ?? "undefined"}`),
      truncatedSample: coercedCategories.length > LOGGED_CATEGORY_SAMPLE,
      allowed: FINDING_CATEGORIES.join("|"),
      model: response.model,
      hint: "The findings were KEPT. If one value recurs, either the prompt's category guidance needs work or the enum is genuinely missing a bucket.",
    });
  }

  const validated = schema.parse(clampAgentOutputStrings(parsed));

  // Enrich citations with retrieval metadata when possible.
  validated.findings = validated.findings.map((f) => ({
    ...f,
    citations: enrichCitations(f.citations, input.retrieved),
  }));

  return {
    agentKey: input.agentKey,
    output: validated,
    usage: response.usage ?? DEFAULT_USAGE,
    durationMs: Date.now() - start,
  };
}
