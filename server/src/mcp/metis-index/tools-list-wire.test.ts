/**
 * #2331 — the `tools/list` answer `metis-index-mcp` gives an MCP host: every
 * tool's name, description, input and output JSON Schema and annotations, as
 * the SDK derives them from our zod shapes. A host's model reads exactly this,
 * so a change to it (a reworded description, a schema drift on a zod or SDK
 * upgrade) must be a reviewed change to the snapshot, never a silent one.
 *
 * Driven through a real SDK client over the in-memory transport.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createIndexMcpServer } from "./server.js";

async function listTools() {
  const server = createIndexMcpServer({ credential: "metis_unused" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pin", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("metis-index-mcp tools/list", () => {
  it("advertises the eight metis_ tools exactly as recorded", async () => {
    const tools = [...(await listTools())].sort((a, b) => a.name.localeCompare(b.name));
    await expect(JSON.stringify(tools, null, 2) + "\n").toMatchFileSnapshot(
      "__snapshots__/tools-list.json.snap",
    );
  });

  it("closes every input object and requires projectId on every project tool", async () => {
    for (const t of await listTools()) {
      if (t.name === "metis_list_projects") {
        expect(t.inputSchema).toMatchObject({ type: "object", properties: {} });
        continue;
      }
      expect(t.inputSchema, t.name).toMatchObject({ additionalProperties: false });
      expect(t.inputSchema.required, t.name).toContain("projectId");
    }
  });
});
