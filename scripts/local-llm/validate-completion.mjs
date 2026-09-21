/**
 * Pure response-validation core for the local-LLM chat-completions smoke test
 * (issue #332). Kept free of I/O so it is trivially unit-testable: the network
 * shell in `smoke-test.mjs` parses the HTTP response into a plain object and
 * hands it here.
 *
 * The validator answers one question — "did this OpenAI-compatible `/v1/chat/
 * completions` response return usable assistant text?" — and, crucially, it
 * diagnoses the **reasoning-model empty-content trap** the parent measured on
 * this hardware:
 *
 *   The current METIS default `gemma4:12b` is a REASONING model. Served over
 *   `/v1`, at a low `max_tokens` it spends the entire token budget inside a
 *   `reasoning` / `reasoning_content` field and returns an EMPTY
 *   `choices[0].message.content` with `finish_reason: "length"`. A naive smoke
 *   test that only checks HTTP 200 would call that a pass; doc-generation would
 *   then silently produce empty sections. So an empty `content` that is
 *   accompanied by reasoning tokens OR truncated by length is reported as a
 *   distinct, actionable failure (`reasoning-empty-content`) rather than a
 *   generic "empty response".
 *
 * Result shape (discriminated by `ok`):
 *   { ok: true,  content, finishReason, reason: "ok" }
 *   { ok: false, reason, message, finishReason?, hasReasoning? }
 *
 * `reason` is a stable machine code so callers (and tests) can branch without
 * string-matching the human `message`.
 */

/**
 * Stable failure/sucess codes. Exported so tests and callers don't duplicate
 * the literals.
 * @typedef {"ok"
 *   | "not-an-object"
 *   | "api-error"
 *   | "no-choices"
 *   | "no-message"
 *   | "reasoning-empty-content"
 *   | "empty-content"} SmokeReason
 */

/** @type {{ OK: "ok" } & Record<string, string>} */
export const SMOKE_REASON = Object.freeze({
  OK: "ok",
  NOT_AN_OBJECT: "not-an-object",
  API_ERROR: "api-error",
  NO_CHOICES: "no-choices",
  NO_MESSAGE: "no-message",
  REASONING_EMPTY_CONTENT: "reasoning-empty-content",
  EMPTY_CONTENT: "empty-content",
});

/**
 * Coerce an OpenAI-compatible `message.content` into a string. The spec allows
 * `content` to be a string OR an array of content parts (`{type:"text",text}`);
 * some runtimes (and tool-call deltas) also send `null`. We concatenate the
 * text parts so a structured-but-non-empty answer is not mis-flagged as empty.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * True when the assistant message carries reasoning/thinking tokens. Different
 * runtimes spell this differently: vLLM/DeepSeek-style use `reasoning_content`,
 * others use `reasoning`. A non-empty value of either counts.
 *
 * @param {Record<string, unknown> | null | undefined} message
 * @returns {boolean}
 */
export function hasReasoningTokens(message) {
  if (!message || typeof message !== "object") return false;
  const candidates = [message.reasoning, message.reasoning_content];
  return candidates.some((v) => typeof v === "string" && v.trim().length > 0);
}

/**
 * Validate a parsed chat-completions response body.
 *
 * @param {unknown} body Parsed JSON from `<base>/chat/completions`.
 * @returns {{ ok: true, content: string, finishReason: string | null, reason: "ok" }
 *   | { ok: false, reason: string, message: string, finishReason?: string | null, hasReasoning?: boolean }}
 */
export function validateChatCompletion(body) {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      reason: SMOKE_REASON.NOT_AN_OBJECT,
      message: "Response body was not a JSON object.",
    };
  }

  // OpenAI-compatible servers surface failures as `{ error: {...} }` even with
  // a 200 in some proxies — treat any `error` field as a hard failure.
  const errObj = /** @type {{ error?: unknown }} */ (body).error;
  if (errObj != null) {
    const errMessage =
      errObj && typeof errObj === "object"
        ? /** @type {{ message?: unknown }} */ (errObj).message
        : undefined;
    const msg =
      (typeof errMessage === "string"
        ? errMessage
        : typeof errObj === "string"
          ? errObj
          : JSON.stringify(errObj)) || "unknown API error";
    return { ok: false, reason: SMOKE_REASON.API_ERROR, message: `API returned an error: ${msg}` };
  }

  const choices = /** @type {Record<string, unknown>} */ (body).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return {
      ok: false,
      reason: SMOKE_REASON.NO_CHOICES,
      message: "Response had no `choices[]` — the server returned no completion.",
    };
  }

  const choice = /** @type {Record<string, unknown>} */ (choices[0]) ?? {};
  const finishReasonRaw = choice.finish_reason;
  const finishReason = typeof finishReasonRaw === "string" ? finishReasonRaw : null;
  const message = /** @type {Record<string, unknown> | undefined} */ (choice.message);

  if (!message || typeof message !== "object") {
    return {
      ok: false,
      reason: SMOKE_REASON.NO_MESSAGE,
      message: "`choices[0].message` was missing — cannot read assistant content.",
      finishReason,
    };
  }

  const content = extractTextContent(message.content).trim();
  if (content.length > 0) {
    return { ok: true, content, finishReason, reason: SMOKE_REASON.OK };
  }

  // Empty content — diagnose WHY. The reasoning-model trap: the model burned the
  // budget on reasoning tokens (and/or hit the length cap) and never emitted a
  // visible answer. This is the #332 footgun and gets its own actionable code.
  const reasoning = hasReasoningTokens(message);
  const truncatedByLength = finishReason === "length";
  if (reasoning || truncatedByLength) {
    const why = reasoning
      ? "the model returned reasoning/thinking tokens but EMPTY visible content"
      : "the completion was truncated (`finish_reason: length`) before any visible content was emitted";
    return {
      ok: false,
      reason: SMOKE_REASON.REASONING_EMPTY_CONTENT,
      message:
        `Reasoning-model empty-content trap: ${why}. ` +
        "This is the documented #332 footgun — a REASONING model (e.g. gemma4:12b) " +
        "spends the token budget thinking and returns no answer at low max_tokens. " +
        "Use a clean INSTRUCT model for doc-gen (e.g. qwen2.5:14b / Qwen3-14B with " +
        "thinking disabled) and/or raise max_tokens. See docs/ops/local-serving.md.",
      finishReason,
      hasReasoning: reasoning,
    };
  }

  return {
    ok: false,
    reason: SMOKE_REASON.EMPTY_CONTENT,
    message: "`choices[0].message.content` was empty (no reasoning tokens, not length-truncated).",
    finishReason,
    hasReasoning: false,
  };
}
