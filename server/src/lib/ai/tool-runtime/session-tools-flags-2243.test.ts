/**
 * #2243 — chat's code-search tools are on by default, measured on the #2237 BA
 * question set; `CHAT_FUSED_CODE_RETRIEVAL` and `RAG_RERANK` showed no gain on
 * top of them and stay off (see the PR and `eval-data/README.md`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({ prisma: {} }));

import { getKeyDef } from "../../config/key-registry.js";
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

describe("the registry's defaults match the defaults applied (#2295)", () => {
  // Each flag the loader reads, by the field it fills. The admin page shows an
  // unset flag by its registered default, so a drift here would show it wrong.
  const FIELDS = {
    CHAT_TOOLS: "chatTools",
    CHAT_CODE_SEARCH_TOOLS: "codeSearchTools",
    CHAT_PROGRESSIVE_SKILLS: "progressiveSkills",
    CHAT_SUBAGENTS: "subAgents",
  } as const;
  const saved = Object.fromEntries(Object.keys(FIELDS).map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("every flag the loader reads registers the value it falls back to", () => {
    for (const k of Object.keys(FIELDS)) delete process.env[k];
    const flags = loadSessionToolsFlags();
    for (const [key, field] of Object.entries(FIELDS)) {
      expect(getKeyDef(key)?.default, key).toBe(String(flags[field]));
    }
  });
});

describe("loadSessionToolsFlags — models without native tool calls (#2295)", () => {
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("keeps the text-protocol code tools off when the flag is unset", () => {
    delete process.env[KEY];
    const flags = loadSessionToolsFlags();
    expect(flags.codeSearchTools).toBe(true);
    expect(flags.codeSearchToolsOnTextProtocol).toBe(false);
  });

  it("offers them on the text protocol when the flag is set to true", () => {
    process.env[KEY] = "true";
    expect(loadSessionToolsFlags().codeSearchToolsOnTextProtocol).toBe(true);
  });

  it("an explicit false turns them off on both protocols", () => {
    process.env[KEY] = "false";
    const flags = loadSessionToolsFlags();
    expect(flags.codeSearchTools).toBe(false);
    expect(flags.codeSearchToolsOnTextProtocol).toBe(false);
  });
});
