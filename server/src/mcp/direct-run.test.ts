/**
 * #2331 — an MCP server boots only when it is the script node was asked to
 * run, on every platform's path separator.
 */
import { describe, expect, it } from "vitest";
import { isDirectRun } from "./direct-run.js";

describe("isDirectRun", () => {
  it.each([
    ["/srv/metis/server/dist/mcp/metis-index/server.js", "metis-index"],
    ["/srv/metis/server/src/mcp/metis-index/server.ts", "metis-index"],
    ["C:\\metis\\server\\dist\\mcp\\metis-index\\server.js", "metis-index"],
    ["C:\\metis\\server\\src\\mcp\\speckit\\server.ts", "speckit"],
    ["/srv/metis/server/dist/mcp/speckit/server.js", "speckit"],
  ] as const)("runs %s as %s", (argv1, server) => {
    expect(isDirectRun(argv1, server)).toBe(true);
  });

  it.each([
    [undefined, "metis-index"],
    ["/srv/metis/server/dist/mcp/speckit/server.js", "metis-index"],
    ["C:\\metis\\server\\dist\\mcp\\metis-index\\server.js", "speckit"],
    ["/srv/metis/node_modules/vitest/vitest.mjs", "metis-index"],
    ["/srv/metis/server/dist/mcp/metis-index/server.js.map", "metis-index"],
  ] as const)("does not run %s as %s", (argv1, server) => {
    expect(isDirectRun(argv1, server)).toBe(false);
  });
});
