/**
 * #2331 — the stdio server's own behaviour: tool results over the wire, the
 * boot refusal, and keeping stdout (the transport) free of log lines.
 */
import winston from "winston";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const m = vi.hoisted(() => ({
  resolveMcpCaller: vi.fn(),
  dispatchIndexTool: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("./identity.js", async (original) => ({
  ...(await original<typeof import("./identity.js")>()),
  resolveMcpCaller: m.resolveMcpCaller,
}));
vi.mock("./dispatcher.js", async (original) => ({
  ...(await original<typeof import("./dispatcher.js")>()),
  dispatchIndexTool: m.dispatchIndexTool,
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    readonly kind = "stdio";
  },
}));

const { createIndexMcpServer, main, resultTrailer, routeLogsToStderr, CREDENTIAL_ENV } =
  await import("./server.js");
const { McpAuthError } = await import("./identity.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");

async function client() {
  const server = createIndexMcpServer({ credential: "metis_x" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const cl = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(s), cl.connect(c)]);
  return { cl, close: async () => (await cl.close(), await server.close()) };
}

afterEach(() => {
  vi.restoreAllMocks();
  m.resolveMcpCaller.mockReset();
  m.dispatchIndexTool.mockReset();
});

describe("createIndexMcpServer", () => {
  it("returns a successful call as structured content and as its JSON text", async () => {
    const output = {
      tool: "metis_index_status",
      projectId: "p1",
      result: "indexed at abc",
      resultCount: null,
      truncated: false,
      citations: [],
      instructions: "fixed",
    };
    m.dispatchIndexTool.mockResolvedValue({ isError: false, output });
    const { cl, close } = await client();
    try {
      const r = await cl.callTool({ name: "metis_index_status", arguments: { projectId: "p1" } });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toEqual(output);
      expect(r.content).toEqual([
        { type: "text", text: "indexed at abc" },
        { type: "text", text: "fixed" },
      ]);
      expect(m.dispatchIndexTool.mock.calls[0]![0].name).toBe("metis_index_status");
      expect(m.dispatchIndexTool.mock.calls[0]![1]).toEqual({ projectId: "p1" });
      expect(m.dispatchIndexTool.mock.calls[0]![2]).toMatchObject({ credential: "metis_x" });
    } finally {
      await close();
    }
  });

  it("returns a refusal as an MCP tool error with the dispatcher's message only", async () => {
    m.dispatchIndexTool.mockResolvedValue({ isError: true, message: "refused" });
    const { cl, close } = await client();
    try {
      const r = await cl.callTool({ name: "metis_list_projects", arguments: {} });
      expect(r).toMatchObject({ isError: true, content: [{ type: "text", text: "refused" }] });
    } finally {
      await close();
    }
  });

  it("rejects out-of-bounds arguments before dispatching", async () => {
    const { cl, close } = await client();
    try {
      const r = await cl.callTool({
        name: "metis_search_symbols",
        arguments: { projectId: "p1", query: "q", limit: 1000 },
      });
      expect(r.isError).toBe(true);
      expect(m.dispatchIndexTool).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("marks every tool read-only", async () => {
    const { cl, close } = await client();
    try {
      const { tools } = await cl.listTools();
      expect(tools).toHaveLength(8);
      for (const t of tools) expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true });
    } finally {
      await close();
    }
  });
});

describe("resultTrailer", () => {
  const base = {
    tool: "t",
    projectId: "p",
    result: "r",
    citations: [],
  };
  it("gives the count, the cut and the instructions, in that order", () => {
    expect(
      resultTrailer({ ...base, resultCount: 3, truncated: true, instructions: "Instr." }),
    ).toBe(
      "Results: 3\nTruncated: there is more; narrow the query or the line range to see it.\nInstr.",
    );
  });
  it("leaves out what a result does not have", () => {
    expect(
      resultTrailer({ ...base, resultCount: null, truncated: false, instructions: null }),
    ).toBe("");
    expect(resultTrailer({ ...base, resultCount: 0, truncated: false, instructions: null })).toBe(
      "Results: 0",
    );
  });
});

describe("main", () => {
  it("refuses to boot without a credential that resolves to a user", async () => {
    m.resolveMcpCaller.mockRejectedValue(new McpAuthError("missing"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const connect = vi.spyOn(McpServer.prototype, "connect");
    await expect(main({})).rejects.toThrow(`${CREDENTIAL_ENV}: METIS refused the credential`);
    expect(m.resolveMcpCaller).toHaveBeenCalledWith("");
    expect(connect).not.toHaveBeenCalled();
  });

  it("passes on an error that is not a refusal", async () => {
    m.resolveMcpCaller.mockRejectedValue(new Error("database unreachable"));
    await expect(main({ [CREDENTIAL_ENV]: "metis_x" })).rejects.toThrow("database unreachable");
  });

  it("connects a stdio transport once the credential resolves", async () => {
    m.resolveMcpCaller.mockResolvedValue({ userId: "u1" });
    const connect = vi.spyOn(McpServer.prototype, "connect").mockResolvedValue();
    await main({ [CREDENTIAL_ENV]: "metis_x" });
    expect(m.resolveMcpCaller).toHaveBeenCalledWith("metis_x");
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ kind: "stdio" }));
  });
});

describe("routeLogsToStderr", () => {
  it("sends every logger level and console.log/info/debug to stderr", () => {
    const transport = new winston.transports.Console({ stderrLevels: ["error"] });
    const error = vi.fn();
    const con = { log: vi.fn(), info: vi.fn(), debug: vi.fn(), error };
    routeLogsToStderr({ transports: [transport] }, con);
    const levels = (transport as unknown as { stderrLevels: Record<string, boolean> }).stderrLevels;
    for (const l of ["error", "warn", "info", "http", "verbose", "debug", "silly"]) {
      expect(levels[l], l).toBe(true);
    }
    con.log("a");
    con.info("b");
    con.debug("c");
    expect(error.mock.calls).toEqual([["a"], ["b"], ["c"]]);
  });

  it("leaves a transport that is not the console alone", () => {
    const other = { stderrLevels: undefined } as unknown as winston.transport;
    const con = { log: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    routeLogsToStderr({ transports: [other] }, con);
    expect((other as unknown as { stderrLevels: unknown }).stderrLevels).toBeUndefined();
  });
});
