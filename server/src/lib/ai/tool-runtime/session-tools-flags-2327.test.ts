/**
 * #2327 — `CHAT_CODE_SEARCH_PRIMITIVES`: chat's search primitives
 * (`grep_files`, `list_files`, `search_code_symbols`'s filters) stay behind the
 * key, off by default, until a measurement clears them (see the PR and
 * `eval-data/README.md`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({ prisma: {} }));

import { CODE_SEARCH_PRIMITIVES_DEFAULT, loadSessionToolsFlags } from "./session-tools.js";

const KEY = "CHAT_CODE_SEARCH_PRIMITIVES";

describe("loadSessionToolsFlags — CHAT_CODE_SEARCH_PRIMITIVES (#2327)", () => {
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("reads the measured default when the key is unset", () => {
    delete process.env[KEY];
    expect(CODE_SEARCH_PRIMITIVES_DEFAULT).toBe(false);
    expect(loadSessionToolsFlags().codeSearchPrimitives).toBe(false);
  });

  it("lets an operator turn them on and off", () => {
    process.env[KEY] = "true";
    expect(loadSessionToolsFlags().codeSearchPrimitives).toBe(true);
    process.env[KEY] = "0";
    expect(loadSessionToolsFlags().codeSearchPrimitives).toBe(false);
  });
});
