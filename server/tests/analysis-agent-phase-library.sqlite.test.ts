/**
 * #236 — the analysis agent phase runs LIBRARY agents a project has explicitly
 * enabled, through the one runtime (`runAgent`), alongside its enabled custom
 * agents. Before #236 the phase listed `custom_agent_enablements` only, so a
 * library agent could never take part in an analysis.
 *
 * Real SQLite, real services. Opt-in is explicit: a library agent with no
 * `ProjectAgentAllowlist` row, a row switched off, or a disabled agent does
 * not run. The run is text only — no tools are offered (no person is present
 * to approve one) — and the agent's skills ride inline.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import { bodyMarker, IDS, seedAgentsFixture } from "./helpers/agents-fixture.js";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../src/lib/ai/types.js";

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

const { runEnabledCustomAgents } = await import("../src/lib/analysis/custom-agent-phase.js");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#236 — library agents in the analysis agent phase (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("236-analysis-library");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await seedAgentsFixture(db);
      const lib = (id: string, enabled = true) =>
        db.agent.create({
          data: { id, key: id, name: id, systemPrompt: `You are ${id}.`, enabled },
        });
      await lib("a-unlisted"); // installed, never enabled for the project
      await lib("a-off"); // enabled for the project, then switched off
      await lib("a-disabled", false); // allow-listed, but the agent itself is disabled
      await db.projectAgentAllowlist.createMany({
        data: [
          { projectId: IDS.project, agentId: IDS.lead, enabled: true },
          { projectId: IDS.project, agentId: "a-off", enabled: false },
          { projectId: IDS.project, agentId: "a-disabled", enabled: true },
          // Another project's opt-in never runs here.
          { projectId: IDS.otherProject, agentId: "a-unlisted", enabled: true },
        ],
      });
      await db.customAgentEnablement.create({
        data: { customAgentId: IDS.helper, projectId: IDS.project, enabled: true },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("runs the explicitly enabled library agent and the enabled custom agent — text only, skills inline", async () => {
      const calls: Array<{ messages: ChatMessage[]; opts: ChatOptions }> = [];
      const provider = {
        key: "openai",
        model: "gpt-4.1",
        chat: vi.fn(async (messages: ChatMessage[], opts: ChatOptions): Promise<ChatResponse> => {
          calls.push({ messages, opts });
          return {
            // #289 — a valid findings answer, so no final-answer retry fires.
            content: JSON.stringify({
              summary: `finding from ${String(opts.systemMessage).slice(0, 20)}`,
              findings: [],
              notes: [],
            }),
            usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
            model: "gpt-4.1",
            provider: "openai",
          } as ChatResponse;
        }),
      } as unknown as AIProvider;

      const res = await runEnabledCustomAgents({
        provider,
        projectId: IDS.project,
        projectName: "P one",
        projectDescription: "A project.",
      });

      expect(res.results.map((r) => [r.agentRef, r.kind, r.error ?? null])).toEqual([
        [`library:${IDS.lead}`, "library", null],
        [`custom:${IDS.helper}`, "custom", null],
      ]);
      expect(res.usage).toEqual({ promptTokens: 6, completionTokens: 4, totalTokens: 10 });

      const lead = calls.find((c) => String(c.opts.systemMessage).includes("You are the lead."));
      expect(lead).toBeDefined();
      // No tools on the call, even though the lead's allowlist names several.
      expect(lead!.opts.disableTools).toBe(true);
      expect(lead!.opts.tools ?? []).toEqual([]);
      // Its skill rides inline (no load_skill without tools).
      expect(String(lead!.opts.systemMessage)).toContain(bodyMarker("style-guide"));
      // The project framing is the untrusted input, in its delimited block.
      expect(lead!.messages[0]!.content).toContain("<USER_INPUT>");
      expect(lead!.messages[0]!.content).toContain("Project: P one");
    });
  },
);
