import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FIXTURE_DIR, FixtureStore, resolveFixtureDir } from "./fixture-store.js";
import type { ChatMessage, ChatResponse } from "../types.js";

const resp = (content = "hello"): ChatResponse => ({
  content,
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  model: "m",
  provider: "bedrock-gateway",
});

const msgs: ChatMessage[] = [{ role: "user", content: "question" }];

describe("resolveFixtureDir", () => {
  const original = process.env.AI_FIXTURE_DIR;
  afterEach(() => {
    if (original === undefined) delete process.env.AI_FIXTURE_DIR;
    else process.env.AI_FIXTURE_DIR = original;
  });

  it("defaults to DEFAULT_FIXTURE_DIR resolved against cwd", () => {
    delete process.env.AI_FIXTURE_DIR;
    expect(resolveFixtureDir("/srv")).toBe(path.resolve("/srv", DEFAULT_FIXTURE_DIR));
  });

  it("honours an absolute AI_FIXTURE_DIR verbatim", () => {
    process.env.AI_FIXTURE_DIR = "/abs/fix";
    expect(resolveFixtureDir("/srv")).toBe("/abs/fix");
  });

  it("resolves a relative AI_FIXTURE_DIR against cwd", () => {
    process.env.AI_FIXTURE_DIR = "rel/fix";
    expect(resolveFixtureDir("/srv")).toBe(path.resolve("/srv", "rel/fix"));
  });

  it("treats blank AI_FIXTURE_DIR as unset", () => {
    process.env.AI_FIXTURE_DIR = "   ";
    expect(resolveFixtureDir("/srv")).toBe(path.resolve("/srv", DEFAULT_FIXTURE_DIR));
  });
});

describe("FixtureStore", () => {
  let dir: string;
  let store: FixtureStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "fixstore-"));
    store = new FixtureStore(dir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("exposes its directory", () => {
    expect(store.directory).toBe(dir);
  });

  it("returns null for a missing fixture", async () => {
    expect(await store.read("nope")).toBeNull();
    expect(await store.has("nope")).toBe(false);
  });

  it("writes then reads a fixture round-trip", async () => {
    const written = await store.write("k1", msgs, { model: "m" }, resp("captured"));
    expect(written.version).toBe(1);
    expect(written.key).toBe("k1");
    expect(written.request.messageCount).toBe(1);
    expect(written.request.promptPreview).toBe("question");
    expect(written.request.options).toEqual({ model: "m" });

    const read = await store.read("k1");
    expect(read?.response.content).toBe("captured");
    expect(await store.has("k1")).toBe(true);
  });

  it("overwrites an existing fixture on re-write", async () => {
    await store.write("k1", msgs, {}, resp("v1"));
    await store.write("k1", msgs, {}, resp("v2"));
    expect((await store.read("k1"))?.response.content).toBe("v2");
  });

  it("creates the fixture directory lazily", async () => {
    const nested = new FixtureStore(path.join(dir, "deep", "nest"));
    await nested.write("k", msgs, {}, resp());
    expect(await nested.has("k")).toBe(true);
  });

  it("lists fixture keys, ignoring non-json files", async () => {
    await store.write("aaa", msgs, {}, resp());
    await store.write("bbb", msgs, {}, resp());
    await fs.writeFile(path.join(dir, "README.md"), "x");
    const keys = await store.list();
    expect(keys.sort()).toEqual(["aaa", "bbb"]);
  });

  it("returns empty list when the directory does not exist", async () => {
    const ghost = new FixtureStore(path.join(dir, "missing"));
    expect(await ghost.list()).toEqual([]);
  });

  it("returns null on corrupt JSON", async () => {
    await fs.writeFile(path.join(dir, "bad.json"), "{not json");
    expect(await store.read("bad")).toBeNull();
  });

  it("returns null when version is unsupported", async () => {
    await fs.writeFile(
      path.join(dir, "old.json"),
      JSON.stringify({ version: 99, response: resp() }),
    );
    expect(await store.read("old")).toBeNull();
  });

  it("uses a placeholder preview when there is no user message", async () => {
    const sysOnly: ChatMessage[] = [{ role: "system", content: "sys" }];
    const written = await store.write("k", sysOnly, {}, resp());
    expect(written.request.promptPreview).toBe("(no prompt)");
  });
});
