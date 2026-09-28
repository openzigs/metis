/**
 * #289 — the analysis agent phase's findings reach the analysis.
 *
 * Before #289 `AnalysisOrchestrator` kept only the phase's token usage: every
 * enabled custom and library agent was paid for and its answer discarded. Here
 * the REAL `AnthropicProvider` talks to a loopback server that answers in the
 * bytes DeepSeek's Anthropic-compatible endpoint really sends (the recorded
 * `provider-contract/deepseek/text-chat.json` envelope, with the scripted
 * answer text swapped in), over a real migrated SQLite database. The result is
 * read back through the paths a consumer uses — the analysis snapshot
 * (`GET /api/analyses/:id`) and `readFlattenedFindings` (what synthesis reads)
 * — never through the object the phase returned.
 */
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import { IDS, seedAgentsFixture } from "./helpers/agents-fixture.js";
import { systemOf, type Body } from "./helpers/provider-wire.js";
import { RECORDED_FIXTURE_ROOT } from "./lib/ai/provider-contract/recorded.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { persistAgentPhaseResults, runEnabledCustomAgents, AGENT_PHASE_OUTPUT_CONTRACT } =
  await import("../src/lib/analysis/custom-agent-phase.js");
const { getAnalysisSnapshot, persistAgentResult, readFlattenedFindings } =
  await import("../src/lib/analysis/analysis-service.js");
const { AnthropicProvider } = await import("../src/lib/ai/providers/anthropic-provider.js");

/** The recorded DeepSeek reply envelope (Anthropic Messages wire). */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(RECORDED_FIXTURE_ROOT, "deepseek", "text-chat.json"), "utf8"),
) as { exchanges: Array<{ response: { json: Record<string, unknown> } }> };

function deepseekReply(text: string): string {
  const json = structuredClone(RECORDED.exchanges[0]!.response.json);
  json.content = [{ type: "text", text }];
  return JSON.stringify(json);
}

const RAMBLER = "c-rambler";
const LIB_OFF = "a-off";
const ANALYSIS = "an-289";

const findingsAnswer = (title: string, category: string) =>
  JSON.stringify({
    summary: `${title} summary`,
    findings: [
      {
        category,
        severity: "medium",
        title,
        body: `${title} body`,
        tags: [],
        citations: [],
      },
    ],
    notes: [],
  });

/** What the scripted "model" answers, by the persona in the system prompt. */
const SCRIPT: Array<[string, string]> = [
  ["You are the lead.", findingsAnswer("Lead: release gate is missing", "reliability")],
  ["You are the helper.", findingsAnswer("Helper: row counts are unbounded", "performance")],
  ["You are the rambler.", "I think the project is interesting and has several risks."],
  ["You are off.", findingsAnswer("Off: must never appear", "other")],
  ["You are the writer.", findingsAnswer("Writer: must never appear", "other")],
];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#289 — agent-phase findings are persisted with their source (real SQLite, real provider)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let server: Server;
    let base = "";
    const seen: Array<{ system: string; body: Body }> = [];

    beforeAll(async () => {
      sqlite = createMigratedSqlite("289-agent-findings");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await seedAgentsFixture(db);
      await db.agent.create({
        data: { id: LIB_OFF, key: LIB_OFF, name: LIB_OFF, systemPrompt: "You are off." },
      });
      await db.customAgent.create({
        data: {
          id: RAMBLER,
          projectId: IDS.project,
          name: "Rambler",
          systemPrompt: "You are the rambler.",
          tools: "[]",
        },
      });
      await db.projectAgentAllowlist.createMany({
        data: [
          { projectId: IDS.project, agentId: IDS.lead, enabled: true },
          { projectId: IDS.project, agentId: LIB_OFF, enabled: false },
        ],
      });
      await db.customAgentEnablement.createMany({
        data: [
          { customAgentId: IDS.helper, projectId: IDS.project, enabled: true },
          { customAgentId: RAMBLER, projectId: IDS.project, enabled: true },
          // Disabled for the project: must contribute nothing.
          { customAgentId: IDS.writer, projectId: IDS.project, enabled: false },
        ],
      });
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: IDS.project, startedById: IDS.alice, status: "running" },
      });

      server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
        req.on("end", () => {
          const body = (raw ? JSON.parse(raw) : {}) as Body;
          const system = systemOf(body);
          seen.push({ system, body });
          const hit = SCRIPT.find(([persona]) => system.includes(persona));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(deepseekReply(hit ? hit[1] : "unscripted"));
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic`;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("persists each enabled agent's findings with its source; an invalid answer is a visible failed row", async () => {
      // A specialist's findings, persisted the way the orchestrator does.
      await persistAgentResult({
        analysisId: ANALYSIS,
        agentKey: "document",
        status: "completed",
        output: {
          agentKey: "document",
          summary: "doc",
          findings: [
            {
              category: "compliance",
              severity: "low",
              title: "Doc: retention rule missing",
              body: "b",
              tags: [],
              citations: [],
            },
          ],
          notes: [],
        },
        startedAt: new Date(0),
        completedAt: new Date(1),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });

      const provider = new AnthropicProvider({
        apiKey: "k",
        baseUrl: base,
        model: "deepseek-v4-pro",
      });
      const phase = await runEnabledCustomAgents({
        provider,
        projectId: IDS.project,
        projectName: "P one",
        projectDescription: "A project.",
      });
      await persistAgentPhaseResults(ANALYSIS, phase.results);

      // ── The wire: text only, the findings contract in the system prompt ──
      for (const s of seen) {
        expect(s.system).toContain(AGENT_PHASE_OUTPUT_CONTRACT.split("\n")[0]);
        expect(s.body.tools ?? []).toEqual([]);
      }
      // Disabled agents were never called.
      expect(seen.some((s) => s.system.includes("You are off."))).toBe(false);
      expect(seen.some((s) => s.system.includes("You are the writer."))).toBe(false);
      // The rambler got exactly ONE retry (#769), the others none.
      expect(seen.filter((s) => s.system.includes("You are the rambler."))).toHaveLength(2);
      expect(seen).toHaveLength(4);
      // Usage from the recorded envelope (27 in + 6 out per call), all 4 calls.
      expect(phase.usage.totalTokens).toBe(4 * 33);

      // ── Read back through the snapshot (GET /api/analyses/:id) ──
      const snap = await getAnalysisSnapshot(ANALYSIS);
      const byKey = new Map(snap!.agents.map((a) => [a.agentKey, a]));
      expect([...byKey.keys()].sort()).toEqual(
        ["custom:c-helper", `custom:${RAMBLER}`, "document", "library:a-lead"].sort(),
      );

      const lead = byKey.get("library:a-lead")!;
      expect(lead.status).toBe("completed");
      expect(lead.source).toEqual({ kind: "library", ref: "library:a-lead", name: "Lead" });
      expect(lead.findings.map((f) => [f.title, f.category])).toEqual([
        ["Lead: release gate is missing", "reliability"],
      ]);

      const helper = byKey.get("custom:c-helper")!;
      expect(helper.source).toEqual({ kind: "custom", ref: "custom:c-helper", name: "Helper" });
      expect(helper.findings.map((f) => f.title)).toEqual(["Helper: row counts are unbounded"]);

      const rambler = byKey.get(`custom:${RAMBLER}`)!;
      expect(rambler.status).toBe("failed");
      expect(rambler.findings).toEqual([]);
      expect(rambler.errorMessage).toBe(
        "No findings recorded: its answer contained no JSON object after one retry.",
      );
      expect(rambler.source?.name).toBe("Rambler");

      expect(byKey.get("document")!.source).toBeNull();

      // ── Read back through what synthesis reads: merged with the specialist ──
      const flat = await readFlattenedFindings(ANALYSIS);
      expect(flat.map((f) => [f.agentKey, f.title]).sort()).toEqual(
        [
          ["document", "Doc: retention rule missing"],
          ["library:a-lead", "Lead: release gate is missing"],
          ["custom:c-helper", "Helper: row counts are unbounded"],
        ].sort(),
      );
    });
  },
);
