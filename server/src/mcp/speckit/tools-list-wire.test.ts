/**
 * #309 — the `tools/list` answer `metis-speckit-mcp` gives an MCP host, held
 * to what it advertised on zod 3. The MCP SDK derives each tool's `inputSchema`
 * from our zod shapes and takes a DIFFERENT converter per zod major, so the
 * JSON Schema a host (and its model) sees can drift with no code change here.
 *
 * `__snapshots__/tools-list-input-schemas.zod3.json.snap` was RECORDED by this
 * same test on zod 3.25.76 (commit before the bump). It is compared as JSON
 * (key order is not meaning), with exactly one documented difference: zod 4's
 * `.int()` accepts only safe integers, and its converter says so with
 * `maximum: Number.MAX_SAFE_INTEGER`.
 *
 * Driven through a real SDK client over the in-memory transport.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSpecKitMcpServer } from "./server.js";

const RECORDED_ON_ZOD3 = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__snapshots__",
  "tools-list-input-schemas.zod3.json.snap",
);

async function listInputSchemas(): Promise<Record<string, unknown>> {
  const prevHosts = process.env.SPECKIT_INSTALL_ALLOWED_API_HOSTS;
  process.env.SPECKIT_INSTALL_ALLOWED_API_HOSTS = "https://metis.local";
  const server = createSpecKitMcpServer({
    config: { apiBaseUrl: "https://metis.local", projectId: "p-309", token: "t" },
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => "{}" }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pin", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const { tools } = await client.listTools();
    return Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
  } finally {
    await client.close();
    await server.close();
    if (prevHosts === undefined) delete process.env.SPECKIT_INSTALL_ALLOWED_API_HOSTS;
    else process.env.SPECKIT_INSTALL_ALLOWED_API_HOSTS = prevHosts;
  }
}

describe("metis-speckit-mcp tools/list", () => {
  it("advertises every tool's inputSchema as it did on zod 3", async () => {
    const recorded = JSON.parse(fs.readFileSync(RECORDED_ON_ZOD3, "utf8")) as Record<
      string,
      { properties: Record<string, Record<string, unknown>> }
    >;
    recorded.speckit_taskstoissues!.properties.parentEpicNumber!.maximum = Number.MAX_SAFE_INTEGER;
    expect(await listInputSchemas()).toEqual(recorded);
  });

  it("emits the closed-object hint on tool objects and on the nested repo object", async () => {
    const schemas = await listInputSchemas();
    expect(schemas.speckit_plan).toMatchObject({ additionalProperties: false });
    expect(schemas.speckit_taskstoissues).toMatchObject({
      additionalProperties: false,
      properties: { repo: { additionalProperties: false } },
    });
  });
});
