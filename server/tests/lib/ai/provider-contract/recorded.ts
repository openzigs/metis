/**
 * Recorded contract fixtures (#197) — the #132/#133 contract scenarios captured
 * from LIVE endpoints under `AI_RECORD=1`, then replayed offline in CI.
 *
 * ## Why the recording is taken at the wire, not at `chat()`
 *
 * The #234 harness (`src/lib/ai/fixtures/`) records at the `AIProvider.chat()`
 * seam: a replayed `ChatResponse` never passes through an adapter, so it can
 * prove nothing about how an adapter PARSES a runtime's reply. The contract
 * question here is exactly that — does the Anthropic Messages client parse what
 * DeepSeek really sends, does the OpenAI-compatible client assemble what Ollama
 * really streams — so this module tees `fetch` while the REAL adapter talks to
 * the live runtime, and on replay serves those bytes back to the same adapter.
 *
 * It reuses the #234 mechanism rather than growing a second one: the same
 * `AI_RECORD` / `AI_RECORD_OVERWRITE` flags (record only fills gaps unless
 * overwrite is set) and the same content-addressed {@link fixtureKey}, which
 * each fixture stores so a scenario whose request changes without a re-record
 * fails loudly as stale instead of replaying a reply to a different question.
 *
 * ## What a replay checks
 *
 *   1. The adapter sends the requests the recording saw, in order: same method,
 *      same path, the same contract-relevant request view (model, tool
 *      names, tool choice, response format, tool-call and tool-result ids),
 *      and the same CONTENT — system prompt, turn text, tool-call arguments
 *      and tool-result content ({@link viewRecordedContent}).
 *   2. Its parsed output equals the output recorded from the live run.
 *   3. The scenario's own contract assertions hold (see `scenarios`).
 *
 * ## Hygiene
 *
 * No request header is ever stored (that is where keys live); URLs keep only
 * path + query; response headers keep only `content-type`; account-scoped
 * message ids, private-network hosts and anything key-shaped are scrubbed on
 * write, and `provider-contract-recorded.test.ts` re-scans every committed
 * fixture on every run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { fixtureKey } from "../../../../src/lib/ai/fixtures/fixture-key.js";
import type {
  AIProvider,
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ChatResponse,
} from "../../../../src/lib/ai/types.js";
import type { ContractRequestView } from "./suite.js";
import { viewAnthropicRequest, viewOpenAIRequest } from "./harnesses.js";

/** Where the committed recordings live. */
export const RECORDED_FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/llm/provider-contract",
);

/** Wire formats a recording can be in. */
export type WireFormat = "anthropic-messages" | "openai-chat-completions";

/** One HTTP request the adapter made, scrubbed. Headers are never stored. */
export interface RecordedRequest {
  method: string;
  /** Path + query only — the host is deliberately dropped. */
  path: string;
  body: Record<string, unknown> | null;
}

/** One HTTP response, scrubbed. Exactly one of `json` / `sse` / `text` is set. */
export interface RecordedResponse {
  status: number;
  contentType: string;
  json?: unknown;
  /** Server-sent events, one entry per event (the text between blank lines). */
  sse?: string[];
  text?: string;
}

export interface RecordedExchange {
  request: RecordedRequest;
  response: RecordedResponse;
}

/** What the adapter returned: a `ChatResponse`, or every chunk of a stream. */
export type RecordedResult =
  | { kind: "chat"; response: ChatResponse }
  | { kind: "stream"; chunks: ChatChunk[] };

export interface RecordedFixture {
  version: 1;
  /** Runtime label (`deepseek`, `ollama`, …). */
  runtime: string;
  wire: WireFormat;
  scenario: string;
  /** {@link fixtureKey} of the scenario request at record time. */
  key: string;
  model: string;
  recordedAt: string;
  exchanges: RecordedExchange[];
  result: RecordedResult;
}

// ── Scrubbing ─────────────────────────────────────────────────────────────

/** RFC 1918 / loopback / link-local IPv4 — a recording must not leak a LAN host. */
const PRIVATE_IPV4 =
  /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|169\.254|127\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g;

/**
 * Patterns that must never appear in a committed fixture. The hygiene test
 * scans for these; {@link scrubText} removes the ones a live reply can carry.
 */
export const FORBIDDEN_FIXTURE_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["api key (sk-…)", /sk-[A-Za-z0-9_-]{6,}/],
  ["bearer token", /bearer\s/i],
  ["authorization header", /authorization/i],
  ["api-key header", /(^|[^a-z])(x-)?api-key/i],
  ["cookie", /set-cookie|"cookie"/i],
  ["private IPv4 host", new RegExp(PRIVATE_IPV4.source)],
  ["organisation id", /"(organization|org_id|openai-organization)"/i],
  ["uuid (request / message id)", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
];

/**
 * Scrub one serialized payload. `secrets` are literal values (the live key)
 * that must not survive even if a runtime echoed them back.
 */
export function scrubText(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("<redacted>");
  return (
    out
      .replace(/sk-[A-Za-z0-9_-]{6,}/g, "<redacted-key>")
      .replace(PRIVATE_IPV4, "local-model-host")
      // Message / completion ids are per-request and account-scoped.
      .replace(/"id"(\s*):(\s*)"msg_[^"]*"/g, '"id"$1:$2"msg_recorded"')
      .replace(/"id"(\s*):(\s*)"chatcmpl-[^"]*"/g, '"id"$1:$2"chatcmpl-recorded"')
      // DeepSeek's Anthropic-compatible endpoint spells the message id as a UUID.
      .replace(
        /"id"(\s*):(\s*)"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/gi,
        '"id"$1:$2"msg_recorded"',
      )
  );
}

/** Keep only the path + query of a URL, never its host. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function splitSse(text: string): string[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

/** Capture a fetch Response body in its readable, scrubbed form. */
export function recordResponseBody(
  status: number,
  contentType: string,
  body: string,
  secrets: readonly string[] = [],
): RecordedResponse {
  const clean = scrubText(body, secrets);
  const base = { status, contentType };
  if (contentType.includes("text/event-stream")) return { ...base, sse: splitSse(clean) };
  if (contentType.includes("json")) {
    try {
      return { ...base, json: JSON.parse(clean) };
    } catch {
      /* fall through: keep the raw text */
    }
  }
  return { ...base, text: clean };
}

// ── Record: tee the real fetch ────────────────────────────────────────────

function requestParts(input: unknown, init?: RequestInit): { url: string; method: string } {
  if (input instanceof Request) return { url: input.url, method: input.method };
  return { url: String(input), method: init?.method ?? (init?.body ? "POST" : "GET") };
}

function parseBody(raw: unknown, secrets: readonly string[]): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(scrubText(raw, secrets)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Wrap `globalThis.fetch` so every call passes through to the real network and
 * is captured. `finish()` waits for every response body (the adapter reads the
 * original; the recorder reads a clone) and restores `fetch`.
 */
export function teeFetch(secrets: readonly string[]) {
  const real = globalThis.fetch;
  const pending: Array<Promise<RecordedExchange>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const { url, method } = requestParts(input, init);
    const response = await real(input, init);
    const copy = response.clone();
    pending.push(
      copy.text().then((text) => ({
        request: { method, path: pathOf(url), body: parseBody(init?.body, secrets) },
        response: recordResponseBody(
          response.status,
          response.headers.get("content-type") ?? "",
          text,
          secrets,
        ),
      })),
    );
    return response;
  }) as typeof fetch;
  return {
    finish: async (): Promise<RecordedExchange[]> => {
      try {
        return await Promise.all(pending);
      } finally {
        globalThis.fetch = real;
      }
    },
  };
}

// ── Replay: serve the recording back ──────────────────────────────────────

/** Rebuild a fetch Response from a recording, one SSE event per stream chunk. */
export function toResponse(r: RecordedResponse): Response {
  const headers = { "content-type": r.contentType };
  if (r.sse) {
    const encoder = new TextEncoder();
    const events = r.sse;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events) controller.enqueue(encoder.encode(`${e}\n\n`));
        controller.close();
      },
    });
    return new Response(body, { status: r.status, headers });
  }
  const text = r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? "");
  return new Response(text, { status: r.status, headers });
}

/** The contract-relevant view of a request, per wire format. */
export function viewRecordedRequest(
  wire: WireFormat,
  body: Record<string, unknown> | null,
): ContractRequestView & { model: unknown } {
  const view =
    wire === "anthropic-messages"
      ? viewAnthropicRequest(body ?? undefined)
      : viewOpenAIRequest(body ?? undefined);
  return { ...view, model: body?.model };
}

/**
 * One conversation turn as the runtime received it, wire-neutral. Text is the
 * concatenation of every text part; tool arguments are PARSED, so key order and
 * whitespace in a JSON string never count as a divergence.
 */
export interface ContentTurn {
  role: string;
  text: string;
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
  toolResults: Array<{ id: string; content: string }>;
}

/** Everything the model actually reads: the system prompt and every turn. */
export interface ContentView {
  system: string;
  turns: ContentTurn[];
}

/** Join the text of a string, a text-block array, or `null` (→ ""). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: string; text: string } => b?.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("");
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * #197 review — the CONTENT of a request, per wire format: the system prompt,
 * each turn's text, each tool call's name + arguments, and each tool result's
 * content. {@link viewRecordedRequest} only sees ids and names, so an adapter
 * that blanked a tool result or dropped the system prompt still replayed green.
 *
 * Normalised away, because they vary without changing what the model reads:
 * `cache_control` markers, `null` vs `""` content, a string vs a text-block
 * array, and JSON-string vs object tool arguments. The rest of the body
 * (sampling knobs, `thinking`, `stream`) is deliberately not compared: it is
 * adapter policy that can change without a paid re-record, and the scenario
 * input it derives from is already pinned by the fixture key.
 */
export function viewRecordedContent(
  wire: WireFormat,
  body: Record<string, unknown> | null,
): ContentView {
  const messages = (body?.messages as Array<Record<string, unknown>> | undefined) ?? [];
  if (wire === "anthropic-messages") {
    return {
      system: textOf(body?.system),
      turns: messages.map((m) => {
        const blocks = Array.isArray(m.content)
          ? (m.content as Array<Record<string, unknown>>)
          : [];
        return {
          role: String(m.role),
          text: textOf(m.content),
          toolCalls: blocks
            .filter((b) => b.type === "tool_use")
            .map((b) => ({ id: String(b.id), name: String(b.name), args: b.input ?? {} })),
          toolResults: blocks
            .filter((b) => b.type === "tool_result")
            .map((b) => ({ id: String(b.tool_use_id), content: textOf(b.content) })),
        };
      }),
    };
  }
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .join("\n");
  return {
    system,
    turns: messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: String(m.role),
        text: m.role === "tool" ? "" : textOf(m.content),
        toolCalls: (
          (m.tool_calls as Array<{ id: string; function: { name: string; arguments: unknown } }>) ??
          []
        ).map((c) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) })),
        toolResults:
          m.role === "tool" ? [{ id: String(m.tool_call_id), content: textOf(m.content) }] : [],
      })),
  };
}

/** Raised when the adapter's traffic diverges from the recording. */
export class ReplayDivergenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayDivergenceError";
  }
}

/**
 * Install a `fetch` that answers from `fixture.exchanges` in order, checking
 * each outgoing request against the recorded one. `seen` is the adapter's
 * actual traffic; `remaining()` is what it never asked for.
 *
 * A divergence is NOT thrown from inside `fetch`: the Anthropic SDK treats a
 * throwing `fetch` as a connection error and retries it with backoff, which
 * turns a clear failure into a slow, wrapped one. It is collected in
 * `divergences` and answered with a non-retryable 400; the caller raises it.
 */
export function installReplayFetch(fixture: RecordedFixture) {
  const queue = [...fixture.exchanges];
  const seen: RecordedRequest[] = [];
  const divergences: string[] = [];
  const label = `${fixture.runtime}/${fixture.scenario}`;
  const reject = (message: string): Response => {
    divergences.push(message);
    return new Response(
      JSON.stringify({ type: "error", error: { type: "replay_divergence", message } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  };
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const { url, method } = requestParts(input, init);
    const actual: RecordedRequest = {
      method,
      path: pathOf(url),
      body: parseBody(init?.body, []),
    };
    seen.push(actual);
    const next = queue.shift();
    if (!next) return reject(`${label}: unrecorded request ${method} ${actual.path}`);
    if (next.request.method !== method || next.request.path !== actual.path) {
      return reject(
        `${label}: expected ${next.request.method} ${next.request.path}, ` +
          `adapter sent ${method} ${actual.path}`,
      );
    }
    const want = JSON.stringify(viewRecordedRequest(fixture.wire, next.request.body));
    const got = JSON.stringify(viewRecordedRequest(fixture.wire, actual.body));
    if (want !== got) {
      return reject(
        `${label}: request diverges from the recording\n  recorded: ${want}\n  sent:     ${got}`,
      );
    }
    const wantContent = JSON.stringify(viewRecordedContent(fixture.wire, next.request.body));
    const gotContent = JSON.stringify(viewRecordedContent(fixture.wire, actual.body));
    if (wantContent !== gotContent) {
      return reject(
        `${label}: request content diverges from the recording\n` +
          `  recorded: ${wantContent}\n  sent:     ${gotContent}`,
      );
    }
    return toResponse(next.response);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return {
    seen,
    divergences,
    remaining: () => queue.length,
    /** Throw the first divergence, if any. */
    assertNoDivergence: () => {
      if (divergences.length > 0) throw new ReplayDivergenceError(divergences.join("\n"));
    },
  };
}

// ── Scenarios ─────────────────────────────────────────────────────────────

/** A contract scenario: one request, run as `chat` or `stream`. */
export interface RecordedScenario {
  name: string;
  kind: "chat" | "stream";
  messages: ChatMessage[];
  /** Options WITHOUT `model` (the runtime's model is added). */
  opts: Omit<ChatOptions, "model">;
}

/** The request a scenario sends to a runtime, and its fixture key. */
export function scenarioRequest(
  scenario: RecordedScenario,
  model: string,
): { messages: ChatMessage[]; opts: ChatOptions; key: string } {
  const opts: ChatOptions = { ...scenario.opts, model };
  return { messages: scenario.messages, opts, key: fixtureKey(scenario.messages, opts) };
}

/** Run a scenario against a provider and capture what it returned. */
export async function runScenario(
  provider: AIProvider,
  scenario: RecordedScenario,
  model: string,
): Promise<RecordedResult> {
  const { messages, opts } = scenarioRequest(scenario, model);
  if (scenario.kind === "chat") {
    return { kind: "chat", response: await provider.chat(messages, opts) };
  }
  const chunks: ChatChunk[] = [];
  for await (const c of provider.stream(messages, opts)) chunks.push(c);
  return { kind: "stream", chunks };
}

/** JSON round-trip, so `undefined` fields compare equal to absent ones. */
export function normalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ── Fixture files ─────────────────────────────────────────────────────────

export function fixturePath(runtime: string, scenario: string): string {
  return path.join(RECORDED_FIXTURE_ROOT, runtime, `${scenario}.json`);
}

export function readFixture(runtime: string, scenario: string): RecordedFixture | null {
  try {
    return JSON.parse(fs.readFileSync(fixturePath(runtime, scenario), "utf-8")) as RecordedFixture;
  } catch {
    return null;
  }
}

export function writeFixture(fixture: RecordedFixture): void {
  const file = fixturePath(fixture.runtime, fixture.scenario);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`, "utf-8");
}

/** Every committed fixture file, as `[relative path, raw text]`. */
export function listFixtureFiles(root: string = RECORDED_FIXTURE_ROOT): Array<[string, string]> {
  if (!fs.existsSync(root)) return [];
  const out: Array<[string, string]> = [];
  for (const runtime of fs.readdirSync(root)) {
    const dir = path.join(root, runtime);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      out.push([`${runtime}/${f}`, fs.readFileSync(path.join(dir, f), "utf-8")]);
    }
  }
  return out;
}
