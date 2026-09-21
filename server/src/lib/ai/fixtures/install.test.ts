import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeWrapProviderForFixtures, resolveFixtureMode } from "./install.js";
import { RecordingProvider } from "./recording-provider.js";
import { ReplayProvider } from "./replay-provider.js";
import { fixtureKey } from "./fixture-key.js";
import { FixtureStore } from "./fixture-store.js";
import type { AIProvider, ChatMessage, ChatResponse } from "../types.js";

const msgs: ChatMessage[] = [{ role: "user", content: "hello" }];
const resp = (content = "x"): ChatResponse => ({
  content,
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  model: "m",
  provider: "bedrock-gateway",
});

function base(): AIProvider {
  return {
    key: "bedrock-gateway",
    model: "real",
    offline: false,
    chat: vi.fn().mockResolvedValue(resp("live")),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(),
    ping: vi.fn(),
  } as unknown as AIProvider;
}

describe("resolveFixtureMode", () => {
  it("returns off when no flags set", () => {
    expect(resolveFixtureMode({})).toBe("off");
  });
  it("returns replay for AI_REPLAY=1", () => {
    expect(resolveFixtureMode({ AI_REPLAY: "1" })).toBe("replay");
  });
  it("returns record for AI_RECORD=true", () => {
    expect(resolveFixtureMode({ AI_RECORD: "true" })).toBe("record");
  });
  it("prefers replay when both set", () => {
    expect(resolveFixtureMode({ AI_REPLAY: "1", AI_RECORD: "1" })).toBe("replay");
  });
});

describe("maybeWrapProviderForFixtures", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "install-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns the provider unchanged when off", () => {
    const p = base();
    expect(maybeWrapProviderForFixtures(p, { env: {} })).toBe(p);
  });

  it("wraps in RecordingProvider for record mode", () => {
    const wrapped = maybeWrapProviderForFixtures(base(), {
      env: { AI_RECORD: "1" },
      fixtureDir: dir,
    });
    expect(wrapped).toBeInstanceOf(RecordingProvider);
    expect(wrapped.key).toBe("bedrock-gateway");
  });

  it("replaces with ReplayProvider for replay mode and preserves identity", () => {
    const wrapped = maybeWrapProviderForFixtures(base(), {
      env: { AI_REPLAY: "1" },
      fixtureDir: dir,
    });
    expect(wrapped).toBeInstanceOf(ReplayProvider);
    expect(wrapped.key).toBe("bedrock-gateway");
    expect(wrapped.model).toBe("real");
  });

  it("replay end-to-end: a recorded fixture replays via the wrapped provider", async () => {
    const store = new FixtureStore(dir);
    await store.write(fixtureKey(msgs), msgs, {}, resp("recorded!"));
    const wrapped = maybeWrapProviderForFixtures(base(), {
      env: { AI_REPLAY: "1" },
      fixtureDir: dir,
    });
    expect((await wrapped.chat(msgs)).content).toBe("recorded!");
  });

  it("record mode writes a fixture that replay can later read", async () => {
    const recorder = maybeWrapProviderForFixtures(base(), {
      env: { AI_RECORD: "1" },
      fixtureDir: dir,
    });
    await recorder.chat(msgs);
    const replayer = maybeWrapProviderForFixtures(base(), {
      env: { AI_REPLAY: "1" },
      fixtureDir: dir,
    });
    expect((await replayer.chat(msgs)).content).toBe("live");
  });

  it("replay falls back to the offline stub on a miss", async () => {
    const wrapped = maybeWrapProviderForFixtures(base(), {
      env: { AI_REPLAY: "1" },
      fixtureDir: dir,
    });
    // No fixture written — offline stub fallback produces a deterministic reply.
    const out = await wrapped.chat(msgs);
    expect(out.content).toContain("[offline-stub]");
  });
});
