import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixtureStore } from "./fixture-store.js";
import { fixtureKey } from "./fixture-key.js";
import { ReplayFixtureMissError, ReplayProvider } from "./replay-provider.js";
import type { AIProvider, ChatMessage, ChatResponse } from "../types.js";

const msgs: ChatMessage[] = [{ role: "user", content: "ping" }];
const resp = (content = "recorded answer"): ChatResponse => ({
  content,
  usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
  model: "m",
  provider: "bedrock-gateway",
});

function fallback(): AIProvider {
  return {
    key: "offline-stub",
    model: "stub",
    offline: true,
    chat: vi.fn().mockResolvedValue(resp("fallback chat")),
    stream: vi.fn(async function* () {
      yield { type: "delta", content: "fb " };
      yield { type: "done" };
    }),
    embed: vi.fn().mockResolvedValue({ vectors: [[0.1]], dimension: 1, model: "e" }),
    models: vi.fn(),
    ping: vi.fn(),
  } as unknown as AIProvider;
}

describe("ReplayProvider", () => {
  let dir: string;
  let store: FixtureStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "replay-"));
    store = new FixtureStore(dir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("replays a recorded chat deterministically", async () => {
    await store.write(fixtureKey(msgs), msgs, {}, resp("the answer"));
    const p = new ReplayProvider({ store });
    const out = await p.chat(msgs);
    expect(out.content).toBe("the answer");
    expect(p.offline).toBe(false);
  });

  it("carries provider identity from options", async () => {
    const p = new ReplayProvider({ store, key: "bedrock-gateway", model: "gpt" });
    expect(p.key).toBe("bedrock-gateway");
    expect(p.model).toBe("gpt");
    expect(await p.models()).toEqual(["gpt"]);
    expect(await p.ping()).toBe(true);
  });

  it("throws ReplayFixtureMissError on a miss with no fallback", async () => {
    const p = new ReplayProvider({ store });
    await expect(p.chat(msgs)).rejects.toBeInstanceOf(ReplayFixtureMissError);
  });

  it("delegates chat misses to the fallback when provided", async () => {
    const fb = fallback();
    const p = new ReplayProvider({ store, fallbackProvider: fb });
    const out = await p.chat(msgs);
    expect(out.content).toBe("fallback chat");
    expect(fb.chat).toHaveBeenCalledOnce();
  });

  it("synthesises a stream from the recorded content", async () => {
    await store.write(fixtureKey(msgs), msgs, {}, resp("two words"));
    const p = new ReplayProvider({ store });
    const chunks = [];
    for await (const c of p.stream(msgs)) chunks.push(c);
    const deltas = chunks
      .filter((c) => c.type === "delta")
      .map((c) => (c as { content: string }).content);
    expect(deltas.join("")).toBe("two words ");
    expect(chunks.at(-1)).toEqual({ type: "done" });
    expect(chunks.some((c) => c.type === "usage")).toBe(true);
  });

  it("aborts the synthesised stream when the signal fires", async () => {
    await store.write(fixtureKey(msgs), msgs, {}, resp("a b c"));
    const p = new ReplayProvider({ store });
    const ac = new AbortController();
    ac.abort();
    await expect(async () => {
      for await (const _c of p.stream(msgs, { signal: ac.signal })) void _c;
    }).rejects.toMatchObject({ name: "AbortError" });
  });

  it("delegates stream misses to the fallback when provided", async () => {
    const fb = fallback();
    const p = new ReplayProvider({ store, fallbackProvider: fb });
    const chunks = [];
    for await (const c of p.stream(msgs)) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);
    expect(fb.stream).toHaveBeenCalledOnce();
  });

  it("throws on stream miss without fallback", async () => {
    const p = new ReplayProvider({ store });
    await expect(async () => {
      for await (const _c of p.stream(msgs)) void _c;
    }).rejects.toBeInstanceOf(ReplayFixtureMissError);
  });

  it("delegates embed to the fallback", async () => {
    const fb = fallback();
    const p = new ReplayProvider({ store, fallbackProvider: fb });
    const out = await p.embed(["x"]);
    expect(out.dimension).toBe(1);
    expect(fb.embed).toHaveBeenCalledOnce();
  });

  it("throws on embed with no fallback", async () => {
    const p = new ReplayProvider({ store });
    await expect(p.embed(["x"])).rejects.toThrow(/fallback/);
  });
});
