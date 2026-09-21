/**
 * Issue #782 — the embedding env config is validated at BOOT, not per request.
 *
 * `resolvePooling()` / `resolveDtype()` throw on a bad value (correct — a typo
 * must never quietly become `mean`/`q8`), but on the server they are only
 * reached when an embedding backend is first constructed, LAZILY, on the first
 * ingest or search. Without an eager check, `EMBED_POOLING_MAP=acme/m=clss`
 * gives you a server that boots, passes its health check, is handed traffic, and
 * then fails every embed — a strictly worse operational signal than a crashloop.
 *
 * `createApp()` is the server's process boot path (index.ts → createServer →
 * createApp), so the throw lands at startup. This test drives the real
 * `createApp`, not a stub of it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const KEYS = ["EMBED_POOLING", "EMBED_POOLING_MAP", "EMBED_DTYPE"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("createApp() embedding-config validation", () => {
  it("boots with no embedding env set (the default deployment)", () => {
    expect(() => createApp()).not.toThrow();
  });

  it("boots with a fully valid embedding env", () => {
    process.env.EMBED_POOLING_MAP = "acme/custom-embedder=cls";
    process.env.EMBED_POOLING = "mean";
    process.env.EMBED_DTYPE = "fp32";
    expect(() => createApp()).not.toThrow();
  });

  it.each([
    ["EMBED_POOLING_MAP", "acme/model=clss", /Invalid EMBED_POOLING_MAP entry/],
    ["EMBED_POOLING", "clss", /Invalid EMBED_POOLING/],
    ["EMBED_DTYPE", "int4", /Invalid EMBED_DTYPE/],
  ])("refuses to boot when %s is malformed", (key, value, expected) => {
    process.env[key] = value;
    expect(() => createApp()).toThrow(expected);
  });
});
