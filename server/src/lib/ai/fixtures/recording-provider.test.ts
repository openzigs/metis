import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixtureStore } from "./fixture-store.js";
import { fixtureKey } from "./fixture-key.js";
import { RecordingProvider } from "./recording-provider.js";
import type { AIProvider, ChatMessage, ChatResponse } from "../types.js";

const msgs: ChatMessage[] = [{ role: "user", content: "capture me" }];
const resp = (content = "live answer"): ChatResponse => ({
  content,
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  model: "real-model",
  provider: "bedrock-gateway",
});

function inner(overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    key: "bedrock-gateway",
    model: "real-model",
    offline: false,
    chat: vi.fn().mockResolvedValue(resp()),
    stream: vi.fn(async function* () {
      yield { type: "done" };
    }),
    embed: vi.fn().mockResolvedValue({ vectors: [[1]], dimension: 1, model: "e" }),
    models: vi.fn().mockResolvedValue(["real-model"]),
    ping: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as AIProvider;
}

describe("RecordingProvider", () => {
  let dir: string;
  let store: FixtureStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "record-"));
    store = new FixtureStore(dir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("mirrors the inner provider identity", () => {
    const p = new RecordingProvider({ inner: inner(), store });
    expect(p.key).toBe("bedrock-gateway");
    expect(p.model).toBe("real-model");
    expect(p.offline).toBe(false);
  });

  it("passes chat through and captures the response to a fixture", async () => {
    const i = inner();
    const p = new RecordingProvider({ inner: i, store });
    const out = await p.chat(msgs);
    expect(out.content).toBe("live answer");
    expect(i.chat).toHaveBeenCalledOnce();
    const record = await store.read(fixtureKey(msgs));
    expect(record?.response.content).toBe("live answer");
  });

  it("does not overwrite an existing fixture by default", async () => {
    await store.write(fixtureKey(msgs), msgs, {}, resp("old"));
    const p = new RecordingProvider({
      inner: inner({ chat: vi.fn().mockResolvedValue(resp("new")) }),
      store,
    });
    await p.chat(msgs);
    expect((await store.read(fixtureKey(msgs)))?.response.content).toBe("old");
  });

  it("overwrites when overwrite=true", async () => {
    await store.write(fixtureKey(msgs), msgs, {}, resp("old"));
    const p = new RecordingProvider({
      inner: inner({ chat: vi.fn().mockResolvedValue(resp("new")) }),
      store,
      overwrite: true,
    });
    await p.chat(msgs);
    expect((await store.read(fixtureKey(msgs)))?.response.content).toBe("new");
  });

  it("still returns the live response when the fixture write fails", async () => {
    const failing = new FixtureStore(dir);
    vi.spyOn(failing, "has").mockResolvedValue(false);
    vi.spyOn(failing, "write").mockRejectedValue(new Error("disk full"));
    const p = new RecordingProvider({ inner: inner(), store: failing });
    const out = await p.chat(msgs);
    expect(out.content).toBe("live answer");
  });

  it("delegates stream, embed, models, ping to the inner provider", async () => {
    const i = inner();
    const p = new RecordingProvider({ inner: i, store });
    for await (const _c of p.stream(msgs)) void _c;
    await p.embed(["x"]);
    await p.models();
    await p.ping();
    expect(i.stream).toHaveBeenCalledOnce();
    expect(i.embed).toHaveBeenCalledOnce();
    expect(i.models).toHaveBeenCalledOnce();
    expect(i.ping).toHaveBeenCalledOnce();
  });
});
