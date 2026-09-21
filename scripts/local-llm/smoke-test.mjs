#!/usr/bin/env node
/**
 * Local-LLM chat-completions smoke test (issue #332).
 *
 * Given a `LOCAL_GEMMA_BASE_URL` (which MUST end in `/v1`) and a model id, POSTs
 * a tiny chat request to `<base>/chat/completions` and asserts the server
 * returned a NON-EMPTY `choices[0].message.content`. It explicitly diagnoses the
 * reasoning-model empty-content trap (empty content + reasoning tokens, or
 * `finish_reason: "length"`) — see `validate-completion.mjs` for the pure,
 * unit-tested validation core.
 *
 * This is an OPERATOR tool, not part of the server runtime. It performs no live
 * serving itself — point it at an endpoint the user has already brought up per
 * docs/ops/local-serving.md.
 *
 * Usage:
 *   # reads LOCAL_GEMMA_BASE_URL / LOCAL_GEMMA_MODEL / LOCAL_GEMMA_API_KEY from env
 *   node scripts/local-llm/smoke-test.mjs
 *
 *   # or pass explicitly
 *   node scripts/local-llm/smoke-test.mjs --base http://localhost:11434/v1 --model qwen2.5:14b
 *
 *   # Mac (Ollama) example:
 *   LOCAL_GEMMA_BASE_URL=http://localhost:11434/v1 LOCAL_GEMMA_MODEL=qwen2.5:14b \
 *     node scripts/local-llm/smoke-test.mjs
 *
 *   # PC (vLLM) example, cross-machine over the private LAN:
 *   node scripts/local-llm/smoke-test.mjs --base http://192.168.1.50:8000/v1 \
 *     --model Qwen/Qwen3-32B-AWQ --max-tokens 256
 *
 * Flags (all optional; env vars are the default source):
 *   --base <url>        LOCAL_GEMMA_BASE_URL          (required, must end in /v1)
 *   --model <id>        LOCAL_GEMMA_MODEL             (default: gemma4:12b)
 *   --api-key <key>     LOCAL_GEMMA_API_KEY           (default: "ollama" dummy bearer)
 *   --prompt <text>     user prompt                   (default: a fixed sanity prompt)
 *   --max-tokens <n>    max_tokens for the request    (default: 256)
 *   --timeout <ms>      request timeout in ms         (default: 30000)
 *
 * Exit codes: 0 = non-empty completion; 1 = any validation/transport failure.
 *
 * NOTE: this tool deliberately does NOT re-implement METIS's URL guard
 * (`validateLocalProviderUrl`). It is a hand-run diagnostic; the server still
 * enforces loopback/RFC-1918 at config-load time. The runbook instructs
 * operators to only ever use loopback / private-LAN / SSH-tunnel URLs.
 */
import process from "node:process";
import { validateChatCompletion, SMOKE_REASON } from "./validate-completion.mjs";

const DEFAULT_MODEL = "gemma4:12b";
const DEFAULT_PROMPT =
  'Reply with exactly the sentence: "METIS local serving is reachable." and nothing else.';
const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Parse `--flag value` style argv into a flat object. Unknown flags are kept so
 * a typo surfaces as a missing-required error rather than being silently eaten.
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

/**
 * Resolve effective options from argv + env. Pure (no I/O) so it is testable.
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveOptions(argv, env) {
  const args = parseArgs(argv);
  /** @param {unknown} v @returns {string | undefined} */
  const str = (v) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);
  const base = str(args.base) ?? str(env.LOCAL_GEMMA_BASE_URL);
  const model = str(args.model) ?? str(env.LOCAL_GEMMA_MODEL) ?? DEFAULT_MODEL;
  const apiKey = str(args["api-key"]) ?? str(env.LOCAL_GEMMA_API_KEY) ?? "ollama";
  const prompt = str(args.prompt) ?? DEFAULT_PROMPT;
  const maxTokens = Number.parseInt(String(args["max-tokens"] ?? DEFAULT_MAX_TOKENS), 10);
  const timeoutMs = Number.parseInt(String(args.timeout ?? DEFAULT_TIMEOUT_MS), 10);
  return {
    base,
    model,
    apiKey,
    prompt,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Join a base URL ending in `/v1` with the chat-completions path, tolerating a
 * trailing slash. Pure + exported for testing.
 * @param {string} base
 * @returns {string}
 */
export function chatCompletionsUrl(base) {
  return `${base.replace(/\/+$/, "")}/chat/completions`;
}

/* c8 ignore start — network/process shell; the pure logic above + the validator
   carry the coverage. This block does real HTTP and calls process.exit. */

/**
 * Run the smoke test end-to-end. Returns a non-zero number on failure (the CLI
 * maps it to process.exit). Logs human-readable progress to the console.
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
async function run(argv, env) {
  const opts = resolveOptions(argv, env);
  if (!opts.base) {
    console.error(
      "ERROR: no base URL. Set LOCAL_GEMMA_BASE_URL (must end in /v1) or pass --base.\n" +
        "  e.g. node scripts/local-llm/smoke-test.mjs --base http://localhost:11434/v1 --model qwen2.5:14b",
    );
    return 1;
  }
  if (!/\/v1\/?$/.test(opts.base)) {
    console.error(
      `ERROR: LOCAL_GEMMA_BASE_URL must end in /v1 (got "${opts.base}"). ` +
        "METIS's local-gemma provider requires the /v1 suffix.",
    );
    return 1;
  }

  const url = chatCompletionsUrl(opts.base);
  console.log(`Smoke-testing ${url}`);
  console.log(`  model=${opts.model}  max_tokens=${opts.maxTokens}  timeout=${opts.timeoutMs}ms`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: "user", content: opts.prompt }],
        max_tokens: opts.maxTokens,
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === "AbortError";
    const msg = isAbort ? `timed out after ${opts.timeoutMs}ms` : String(err);
    console.error(`FAIL: could not reach ${url} — ${msg}`);
    console.error(
      "  Is the server running? See docs/ops/local-serving.md for start commands and the fallback ladder.",
    );
    return 1;
  }
  clearTimeout(timer);

  let body;
  try {
    body = await res.json();
  } catch {
    console.error(`FAIL: HTTP ${res.status} but the response body was not JSON.`);
    return 1;
  }

  const result = validateChatCompletion(body);
  if (result.ok) {
    console.log(`PASS: non-empty completion (finish_reason=${result.finishReason ?? "n/a"}).`);
    const preview =
      result.content.length > 200 ? `${result.content.slice(0, 200)}…` : result.content;
    console.log(`  content: ${preview}`);
    return 0;
  }

  console.error(`FAIL [${result.reason}]: ${result.message}`);
  if (result.reason === SMOKE_REASON.REASONING_EMPTY_CONTENT) {
    console.error(
      "  --> The endpoint is REACHABLE but the model produced no usable text. " +
        "Pick a clean instruct model (qwen2.5:14b / Qwen3-14B thinking-off), " +
        "NOT a reasoning model like gemma4:12b, for doc-gen.",
    );
  }
  return 1;
}

// Only run when invoked directly (not when imported by a test).
const invokedDirectly = process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  run(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("FAIL: unexpected error", err);
      process.exit(1);
    });
}

/* c8 ignore stop */
