/**
 * #309 — the JSON Schemas Metis sends to model providers, pinned byte-for-byte
 * through the REAL provider classes over a loopback HTTP server.
 *
 * Two families of schema reach a provider's wire:
 *   • native tool definitions — every boot-registered registry tool's zod
 *     argument schema, converted by `toolParametersSchema` (`json-schema.ts`),
 *     plus the MCP bridge's catch-all `z.record` fallback;
 *   • structured-output `response_format` payloads — the analysis findings
 *     schema (#1314's gate validates against it) and the docs-gen grounding
 *     schemas.
 *
 * The snapshot was recorded on zod 3 BEFORE the zod 4 upgrade; the upgrade
 * must leave it unchanged. A converter that silently degrades a schema to `{}`
 * (zod 4 moved `_def.typeName` → `_zod.def.type`) fails here, because the model
 * would otherwise be offered tools it cannot call correctly.
 *
 * Nothing here reaches beyond 127.0.0.1.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../tool-registry.js";
import { toolParametersSchema } from "./json-schema.js";
import { makeToolset, toWireName } from "./toolset.js";
import type { RuntimeTool } from "./types.js";
import { createApplyDiffTool } from "../tools/apply-diff.js";
import { createScoreGroundingTool } from "../tools/score-grounding.js";
import { createInspectSchemaTool } from "../tools/inspect-schema.js";
import { createQueryDatabaseTool } from "../tools/query-database.js";
import { buildSearchKnowledgeTool } from "../../rag/search-knowledge-tool.js";
import { buildSearchKnowledgeGlobalTool } from "../../rag/search-knowledge-global-tool.js";
import {
  createGetRequirementTool,
  createListRequirementsTool,
} from "../../requirements/requirements-chat-tools.js";
import { buildProvider } from "../providers/factory.js";
import { resetLocalConcurrencyLimitersForTests } from "../providers/openai-compatible-provider.js";
import type { AIConfig } from "../config.js";
import type { AIProvider, ChatToolSpec, ToolDefinition } from "../types.js";
import {
  AGENT_OUTPUT_RESPONSE_FORMAT,
  DOCUMENT_AGENT_OUTPUT_RESPONSE_FORMAT,
} from "../../analysis/structured-output-schemas.js";
import {
  CLAIM_DECOMPOSITION_RESPONSE_FORMAT,
  FAITHFULNESS_VERDICTS_RESPONSE_FORMAT,
} from "../../docs-gen/grounding/structured-output-schemas.js";

const seen: Array<Record<string, unknown>> = [];
let server: http.Server;
let origin = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString("utf8")));
    req.on("end", () => {
      seen.push(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      const anthropic = (req.url ?? "").includes("/messages");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          anthropic
            ? {
                id: "msg_pin",
                type: "message",
                role: "assistant",
                model: "loopback-model",
                content: [{ type: "text", text: "{}" }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              }
            : {
                id: "chatcmpl-pin",
                object: "chat.completion",
                model: "loopback-model",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "{}" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
  resetLocalConcurrencyLimitersForTests();
});

function config(over: Partial<AIConfig>): AIConfig {
  return {
    offline: false,
    rateLimit: { windowMs: 60_000, max: 100 },
    pingTimeoutMs: 1_000,
    ...over,
  } as AIConfig;
}

const PROVIDERS: Array<{ name: string; model: string; make: (o: string) => AIProvider }> = [
  {
    name: "anthropic",
    model: "claude-sonnet-4-6",
    make: (o) =>
      buildProvider({
        config: config({
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          sdkProvider: { type: "anthropic", baseUrl: o, apiKey: "test-key" } as never,
        }),
      }),
  },
  {
    name: "openai",
    model: "gpt-4o",
    make: (o) =>
      buildProvider({
        config: config({
          provider: "openai",
          model: "gpt-4o",
          sdkProvider: { type: "openai", baseUrl: `${o}/v1`, apiKey: "test-key" } as never,
        }),
      }),
  },
];

/** The MCP bridge's argument schema when a server advertises no object schema. */
const mcpFallback: ToolDefinition = {
  name: "mcp.example.echo",
  description: "An MCP tool whose server advertised no object input schema",
  risk: "low",
  schema: z.record(z.string(), z.unknown()),
  async exec() {
    return { text: "" };
  },
};

/** Every boot-registered registry tool (server.ts), plus the MCP fallback shape. */
function bootRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of [
    createApplyDiffTool(),
    createScoreGroundingTool(),
    createInspectSchemaTool(),
    createQueryDatabaseTool(),
    buildSearchKnowledgeGlobalTool(),
    buildSearchKnowledgeTool(),
    createListRequirementsTool(),
    createGetRequirementTool(),
    mcpFallback,
  ]) {
    registry.register(t as unknown as ToolDefinition);
  }
  return registry;
}

function bootToolSpecs(): ChatToolSpec[] {
  const registry = bootRegistry();
  const taken = new Set<string>();
  const tools: RuntimeTool[] = registry.describeAll().map((view) => {
    const wireName = toWireName(view.name, taken);
    taken.add(wireName);
    return {
      name: view.name,
      wireName,
      description: view.description,
      parameters: view.parameters,
      risk: view.risk,
      source: "metis",
      validate: () => ({ ok: false }),
      async execute() {
        return { text: "" };
      },
    };
  });
  return makeToolset(tools).specs();
}

describe("provider wire schemas (zod 3 → 4 must-preserve)", () => {
  it("every registry tool's JSON Schema converts exactly as recorded", async () => {
    const byName = Object.fromEntries(
      bootRegistry()
        .describeAll()
        .map((v) => [v.name, v.parameters]),
    );
    await expect(JSON.stringify(byName, null, 2) + "\n").toMatchFileSnapshot(
      "./__snapshots__/registry-tool-parameters.json.snap",
    );
  });

  it.each(PROVIDERS)(
    "$name: native tool definitions on the wire match the recorded bytes",
    async (p) => {
      const provider = p.make(origin);
      await provider.chat([{ role: "user", content: "hi" }], {
        model: p.model,
        tools: bootToolSpecs(),
      });
      expect(seen).toHaveLength(1);
      await expect(JSON.stringify(seen[0]!.tools, null, 2) + "\n").toMatchFileSnapshot(
        `./__snapshots__/wire-tools.${p.name}.json.snap`,
      );
    },
  );

  it.each([
    ["agent-output", AGENT_OUTPUT_RESPONSE_FORMAT],
    ["document-agent-output", DOCUMENT_AGENT_OUTPUT_RESPONSE_FORMAT],
    ["claim-decomposition", CLAIM_DECOMPOSITION_RESPONSE_FORMAT],
    ["faithfulness-verdicts", FAITHFULNESS_VERDICTS_RESPONSE_FORMAT],
  ] as const)(
    "openai: %s response_format on the wire matches the recorded bytes",
    async (name, format) => {
      const provider = PROVIDERS[1]!.make(origin);
      await provider.chat([{ role: "user", content: "hi" }], {
        model: "gpt-4o",
        responseFormat: format,
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.response_format).toBeDefined();
      await expect(JSON.stringify(seen[0]!.response_format, null, 2) + "\n").toMatchFileSnapshot(
        `./__snapshots__/wire-response-format.${name}.json.snap`,
      );
    },
  );
});

describe("toolParametersSchema — every zod shape the converter recognises", () => {
  it("converts each branch as recorded", async () => {
    const schema = z
      .object({
        str: z.string().describe("a string"),
        int: z.number().int().min(1),
        num: z.number(),
        bool: z.boolean().optional(),
        list: z.array(z.string()).max(3),
        choice: z.enum(["a", "b"]),
        lit: z.literal("fixed"),
        rec: z.record(z.string(), z.number()),
        either: z.union([z.string(), z.number()]),
        maybe: z.string().nullable(),
        dflt: z.number().default(5),
        refined: z.string().refine((s) => s.length > 0),
        transformed: z.string().transform((s) => s.length),
        preprocessed: z.preprocess((v) => String(v), z.string()),
        opaque: z.date(),
      })
      .describe("every branch");
    await expect(JSON.stringify(toolParametersSchema(schema), null, 2) + "\n").toMatchFileSnapshot(
      "./__snapshots__/converter-branches.json.snap",
    );
  });

  it("a non-object top level still yields an object parameters schema", () => {
    expect(toolParametersSchema(z.string())).toEqual({ type: "object", properties: {} });
  });
});
