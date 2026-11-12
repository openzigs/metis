/**
 * #2243 — chat's code-search tools are on by default, measured on the #2237 BA
 * question set; `CHAT_FUSED_CODE_RETRIEVAL` and `RAG_RERANK` showed no gain on
 * top of them and stay off (see the PR and `eval-data/README.md`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({ prisma: {} }));

import { loadSessionToolsFlags } from "./session-tools.js";

const KEY = "CHAT_CODE_SEARCH_TOOLS";

describe("loadSessionToolsFlags — CHAT_CODE_SEARCH_TOOLS (#2243)", () => {
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("offers the code-search tools when the flag is unset", () => {
    delete process.env[KEY];
    expect(loadSessionToolsFlags().codeSearchTools).toBe(true);
  });

  it("still lets an operator turn them off", () => {
    process.env[KEY] = "false";
    expect(loadSessionToolsFlags().codeSearchTools).toBe(false);
    process.env[KEY] = "0";
    expect(loadSessionToolsFlags().codeSearchTools).toBe(false);
  });
});
