/**
 * #195 — a factory-built local provider never sends `tools` to a model whose
 * runtime reports no `tools` capability, WITHOUT anyone first calling
 * `GET /api/ai/models`.
 *
 * Real provider class (`buildProvider(loadAIConfig(env))`), real `fetch`, and a
 * loopback HTTP server that speaks the Ollama surface discovery reads
 * (`GET /v1/models`, `POST /api/show`) plus `/v1/chat/completions`. Multi-turn:
 * the facts discovered on the first call serve the later ones from the cache.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildProvider } from "../../../src/lib/ai/providers/factory.js";
import { loadAIConfig } from "../../../src/lib/ai/config.js";
import {
  LOCAL_DISCOVER_CAPABILITIES_ENV,
  resetLocalConcurrencyLimitersForTests,
  resolveLocalDiscoverCapabilities,
} from "../../../src/lib/ai/providers/openai-compatible-provider.js";
import {
  __resetModelCatalogForTests,
  catalogCapabilities,
} from "../../../src/lib/ai/model-catalog.js";
import type { AIProvider, ChatChunk, ChatToolSpec } from "../../../src/lib/ai/types.js";

const NO_TOOLS = "gemma3:12b";
const WITH_TOOLS = "qwen3:8b";
const TOOLS: ChatToolSpec[] = [
  { name: "search_code", description: "search", parameters: { type: "object", properties: {} } },
];

interface Hit {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

let server: http.Server;
let base = "";
let hits: Hit[] = [];
/** Test knobs for the fake runtime. */
let listStatus = 200;
let showDelayMs = 0;

function chatJson(model: string): string {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      const path = (req.url ?? "").split("?")[0];
      hits.push({ method: req.method ?? "", path, body });
      if (req.method === "GET" && path === "/v1/models") {
        res.writeHead(listStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: NO_TOOLS }, { id: WITH_TOOLS }] }));
        return;
      }
      if (req.method === "POST" && path === "/api/show") {
        const caps = body?.model === WITH_TOOLS ? ["completion", "tools"] : ["completion"];
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              model_info: { "gemma3.context_length": 131_072 },
              capabilities: caps,
            }),
          );
        }, showDelayMs);
        return;
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        const model = String(body?.model ?? "");
        if (body?.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } })}\n\n`,
          );
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(chatJson(model));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const savedEnv = process.env[LOCAL_DISCOVER_CAPABILITIES_ENV];
beforeEach(() => {
  hits = [];
  listStatus = 200;
  showDelayMs = 0;
  __resetModelCatalogForTests();
  resetLocalConcurrencyLimitersForTests();
  // tests/setup.ts turns the probe off for the rest of the suite.
  process.env[LOCAL_DISCOVER_CAPABILITIES_ENV] = "1";
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[LOCAL_DISCOVER_CAPABILITIES_ENV];
  else process.env[LOCAL_DISCOVER_CAPABILITIES_ENV] = savedEnv;
  __resetModelCatalogForTests();
});

const local = (model = NO_TOOLS): AIProvider =>
  buildProvider({
    config: loadAIConfig({
      AI_PROVIDER: "local-gemma",
      LOCAL_GEMMA_BASE_URL: base,
      LOCAL_GEMMA_MODEL: model,
    }),
  });

const chatBodies = (): Array<Record<string, unknown>> =>
  hits.filter((h) => h.path === "/v1/chat/completions").map((h) => h.body ?? {});
const count = (path: string): number => hits.filter((h) => h.path === path).length;

async function drain(it: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("#195 — local capabilities are discovered on first use, not only by the picker", () => {
  it("a cold catalog still says the model takes tools — the gap this closes", () => {
    expect(catalogCapabilities("local-gemma", NO_TOOLS, {}).nativeToolCalls).toBe(true);
  });

  it("never sends tools to a no-tools model across a multi-turn chat + stream, probing once", async () => {
    const p = local();
    const turn1 = await p.chat([{ role: "user", content: "one" }], { tools: TOOLS });
    const turn2 = await p.chat(
      [
        { role: "user", content: "one" },
        { role: "assistant", content: turn1.content },
        { role: "user", content: "two" },
      ],
      { tools: TOOLS },
    );
    const chunks = await drain(
      p.stream(
        [
          { role: "user", content: "one" },
          { role: "assistant", content: turn2.content },
          { role: "user", content: "three" },
        ],
        { tools: TOOLS },
      ),
    );

    expect(turn1.content).toBe("ok");
    expect(chunks.some((c) => c.type === "done")).toBe(true);
    const bodies = chatBodies();
    expect(bodies).toHaveLength(3);
    for (const b of bodies) {
      expect(b.model).toBe(NO_TOOLS);
      expect(b).not.toHaveProperty("tools");
      expect(b).not.toHaveProperty("tool_choice");
    }
    // Discovery ran before the first chat request, and only once for 3 turns.
    expect(hits[0]).toMatchObject({ method: "GET", path: "/v1/models" });
    expect(count("/v1/models")).toBe(1);
    expect(count("/api/show")).toBe(2);
    // No 400 round-trip was needed to learn it.
    expect(p.capabilitiesFor?.(NO_TOOLS).nativeToolCalls).toBe(false);
  });

  it("a stream as the very first call is gated too", async () => {
    const p = local();
    await drain(p.stream([{ role: "user", content: "first" }], { tools: TOOLS }));
    const bodies = chatBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].stream).toBe(true);
    expect(bodies[0]).not.toHaveProperty("tools");
    expect(count("/api/show")).toBe(2);
  });

  it("a model whose runtime reports `tools` still gets them (the gate is per model)", async () => {
    const p = local(WITH_TOOLS);
    await p.chat([{ role: "user", content: "one" }], { tools: TOOLS });
    await p.chat([{ role: "user", content: "two" }], { tools: TOOLS });
    const bodies = chatBodies();
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect((b.tools as unknown[] | undefined)?.length).toBe(1);
    }
    expect(count("/v1/models")).toBe(1);
  });

  it("concurrent first calls share one probe", async () => {
    showDelayMs = 30;
    const a = local();
    const b = local();
    await Promise.all([
      a.chat([{ role: "user", content: "a" }], { tools: TOOLS }),
      b.chat([{ role: "user", content: "b" }], { tools: TOOLS }),
    ]);
    expect(count("/v1/models")).toBe(1);
    expect(count("/api/show")).toBe(2);
    for (const body of chatBodies()) expect(body).not.toHaveProperty("tools");
  });

  it("a call without tools, or with tools disabled, never probes", async () => {
    const p = local();
    await p.chat([{ role: "user", content: "plain" }]);
    await p.chat([{ role: "user", content: "off" }], { tools: TOOLS, disableTools: true });
    expect(count("/v1/models")).toBe(0);
    expect(count("/api/show")).toBe(0);
    expect(chatBodies()).toHaveLength(2);
  });

  it("a runtime that cannot be listed is not fatal: the call goes out with tools as before", async () => {
    listStatus = 500;
    const p = local();
    const res = await p.chat([{ role: "user", content: "x" }], { tools: TOOLS });
    expect(res.content).toBe("ok");
    expect((chatBodies()[0].tools as unknown[] | undefined)?.length).toBe(1);
  });

  it("an aborted caller does not wait for a slow probe", async () => {
    showDelayMs = 1_500;
    const p = local();
    const ac = new AbortController();
    const started = Date.now();
    const call = p.chat([{ role: "user", content: "x" }], { tools: TOOLS, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await call.catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it(`${LOCAL_DISCOVER_CAPABILITIES_ENV}=0 turns the probe off`, async () => {
    process.env[LOCAL_DISCOVER_CAPABILITIES_ENV] = "0";
    const p = local();
    await p.chat([{ role: "user", content: "x" }], { tools: TOOLS });
    expect(count("/v1/models")).toBe(0);
    expect((chatBodies()[0].tools as unknown[] | undefined)?.length).toBe(1);
  });

  it("the knob is on unless explicitly turned off", () => {
    expect(resolveLocalDiscoverCapabilities(undefined)).toBe(true);
    expect(resolveLocalDiscoverCapabilities("")).toBe(true);
    expect(resolveLocalDiscoverCapabilities("1")).toBe(true);
    for (const off of ["0", "false", "OFF", " no "]) {
      expect(resolveLocalDiscoverCapabilities(off)).toBe(false);
    }
  });
});
