/**
 * Epic #129 (#145, #146, #147) — agents, progressive skills and sub-agents
 * through the REAL chat routes over a REAL SQLite database (built by the real
 * migration chain). Only the model is substituted: the offline stub with a
 * SCRIPT BOOK (content-selected scripted turns, #148), which makes real native
 * tool calls and records every request it receives — the parent's and every
 * sub-agent's.
 *
 * Every assertion reads back through production code: the model's recorded
 * requests, the SSE stream, `GET /sessions/:id/messages`,
 * `GET /sessions/:id/subagent-runs/:runId` and the `ai_tool_approvals` table.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import { createMigratedSqlite, type MigratedSqlite } from "./helpers/sqlite-migrated-db.js";
import { bodyMarker, IDS, SKILLS, seedAgentsFixture } from "./helpers/agents-fixture.js";
import type { ChatMessage, ToolDefinition } from "../src/lib/ai/types.js";

const state = vi.hoisted(() => {
  process.env.AI_RATE_LIMIT_MAX = "10000";
  return { db: null as unknown };
});
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
vi.mock("../src/lib/rag/knowledge-service.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/knowledge-service.js")>()),
  getKnowledgeService: () => ({ search: async () => ({ hits: [] }) }),
}));

const { aiRouter, setAIProviderForTests } = await import("../src/routes/ai.js");
const { aiConversationRouter } = await import("../src/routes/ai-conversation.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { OfflineStubProvider } = await import("../src/lib/ai/providers/offline-stub-provider.js");
const { __resetToolRegistrySingleton, getToolRegistry } =
  await import("../src/lib/ai/tool-registry.js");
const { __resetToolApprovalBroker, getToolApprovalBroker } =
  await import("../src/lib/ai/tool-runtime/approval-broker.js");
type Stub = InstanceType<typeof OfflineStubProvider>;
type Turn = NonNullable<ConstructorParameters<typeof OfflineStubProvider>[0]>["script"] extends
  | Array<infer T>
  | undefined
  ? T
  : never;

const countExec = vi.fn(async (a: { table: string }) => ({ text: `rows in ${a.table}: 7` }));
const dangerExec = vi.fn(async (a: { table: string }) => ({ text: `wrote ${a.table}` }));

function registerTools(): void {
  getToolRegistry().register({
    name: "count_rows",
    description: "Count rows",
    schema: z.object({ table: z.string() }),
    risk: "low",
    exec: countExec,
  } as ToolDefinition);
  getToolRegistry().register({
    name: "danger_write",
    description: "Write rows",
    schema: z.object({ table: z.string() }),
    risk: "high",
    exec: dangerExec,
  } as ToolDefinition);
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, args });
const HELPER = "agent:custom:c-helper";
const WRITER = "agent:custom:c-writer";

/** The whole book. Parent markers are `SCN-*`; a sub-agent matches on its task (`SUB-*`). */
const BOOK: Array<{ match: string; turns: Turn[] }> = [
  {
    match: "SCN-PROGRESSIVE",
    turns: [
      { toolCalls: [call("c1", "load_skill", { name: "style-guide" })] },
      { content: "styled" },
    ],
  },
  {
    match: "SCN-FILE",
    turns: [
      {
        toolCalls: [
          call("c1", "load_skill", { name: "release-notes", file: "references/TEMPLATE.md" }),
        ],
      },
      { content: "filed" },
    ],
  },
  {
    match: "SCN-TRAVERSAL",
    turns: [
      {
        toolCalls: [
          call("c1", "load_skill", { name: "release-notes", file: "../../../etc/passwd" }),
        ],
      },
      { content: "nope" },
    ],
  },
  {
    match: "SCN-BLOCKED",
    turns: [
      { toolCalls: [call("c1", "load_skill", { name: "blocked-skill" })] },
      { content: "blocked" },
    ],
  },
  {
    match: "SCN-DELEGATE",
    turns: [
      { toolCalls: [call("c1", HELPER, { task: "SUB-HELPER please count table t" })] },
      { content: "parent done" },
    ],
  },
  {
    match: "SUB-HELPER",
    turns: [
      { toolCalls: [call("h1", "danger_write", { table: "t" })] },
      { toolCalls: [call("h2", "count_rows", { table: "t" })] },
      { content: "helper done: 7 rows" },
    ],
  },
  {
    match: "SCN-WRITER",
    turns: [
      { toolCalls: [call("c1", WRITER, { task: "SUB-WRITER write t" })] },
      { content: "parent done" },
    ],
  },
  {
    match: "SUB-WRITER",
    turns: [
      { toolCalls: [call("w1", "danger_write", { table: "t" })] },
      { content: "writer done" },
    ],
  },
  {
    match: "SCN-NEST",
    turns: [
      { toolCalls: [call("c1", WRITER, { task: "SUB-NEST delegate onwards" })] },
      { content: "parent done" },
    ],
  },
  {
    match: "SUB-NEST",
    turns: [
      { toolCalls: [call("n1", HELPER, { task: "SUB-HELPER nested count" })] },
      { content: "nest done" },
    ],
  },
  {
    match: "SCN-BUDGET",
    turns: [
      {
        toolCalls: [
          call("c1", HELPER, { task: "SUB-BIG one" }),
          call("c2", HELPER, { task: "SUB-BIG two" }),
        ],
      },
      { content: "parent done" },
    ],
  },
  {
    match: "SUB-BIG",
    turns: [
      {
        content: "big answer",
        usage: { promptTokens: 400, completionTokens: 100, totalTokens: 500 },
      },
    ],
  },
  {
    match: "SCN-OUTSIDER",
    turns: [
      { toolCalls: [call("c1", "agent:custom:c-outsider", { task: "SUB-HELPER x" })] },
      { content: "parent done" },
    ],
  },
];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "Epic #129 — agents, progressive skills and sub-agents through the chat routes (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let alice: string;
    let bob: string;
    let model: Stub;

    function app() {
      const a = express();
      a.use(express.json());
      a.use("/api/ai", aiRouter());
      a.use("/api/ai", aiConversationRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    }
    const as = (t: string) => ({
      post: (url: string, body?: unknown) =>
        request(app())
          .post(url)
          .set("Authorization", `Bearer ${t}`)
          .send((body ?? {}) as object),
      get: (url: string) => request(app()).get(url).set("Authorization", `Bearer ${t}`),
    });

    async function newSession(body: Record<string, unknown>): Promise<string> {
      const res = await as(alice).post("/api/ai/sessions", body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.data.session.id as string;
    }
    const send = (sessionId: string, message: string) =>
      as(alice).post("/api/ai/stream", { sessionId, message });

    function frames(sse: string, event: string): Array<Record<string, unknown>> {
      return sse
        .split("\n\n")
        .filter((f) => f.startsWith(`event: ${event}\n`))
        .map((f) =>
          JSON.parse(
            f
              .split("\n")
              .find((l) => l.startsWith("data: "))!
              .slice(6),
          ),
        );
    }
    async function toolParts(sessionId: string): Promise<Array<Record<string, unknown>>> {
      const res = await as(alice).get(`/api/ai/sessions/${sessionId}/messages`);
      expect(res.status).toBe(200);
      return (
        res.body.data.messages as Array<{ role: string; parts: Array<Record<string, unknown>> }>
      )
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "tool_result");
    }
    async function waitForPending(
      sessionId: string,
    ): Promise<{ approvalId: string; toolName: string }> {
      for (let i = 0; i < 600; i++) {
        const p = getToolApprovalBroker().listPending(sessionId, IDS.alice);
        if (p.length > 0) return { approvalId: p[0]!.approvalId, toolName: p[0]!.toolName };
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("no approval was requested");
    }
    const decide = (sessionId: string, approvalId: string, decision: "approve" | "deny") =>
      as(alice).post(`/api/ai/sessions/${sessionId}/approvals/${approvalId}`, { decision });

    /** Requests a sub-agent made (its own user message is the framed task). */
    const subRequests = (marker: string) =>
      model.requests.filter((r) => {
        const user = r.messages.find((m) => m.role === "user");
        return (
          typeof user?.content === "string" &&
          user.content.startsWith("<TASK>") &&
          user.content.includes(marker)
        );
      });
    const parentRequests = (marker: string) =>
      model.requests.filter((r) =>
        r.messages.some(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.includes(marker) &&
            !m.content.startsWith("<TASK>"),
        ),
      );
    const toolNames = (r: { opts: { tools?: Array<{ name: string }> } }) =>
      (r.opts.tools ?? []).map((t) => t.name);
    const systemText = (messages: ChatMessage[]) =>
      messages
        .filter((m) => m.role === "system")
        .map((m) => String(m.content))
        .join("\n");

    beforeAll(async () => {
      sqlite = createMigratedSqlite("129-routes");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await seedAgentsFixture(db);
      const tok = (userId: string) =>
        issueTokens({ userId, username: userId, role: "developer", permissions: [] }).accessToken;
      alice = tok(IDS.alice);
      bob = tok(IDS.bob);
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      __resetToolRegistrySingleton();
      __resetToolApprovalBroker();
      registerTools();
      countExec.mockClear();
      dangerExec.mockClear();
      model = new OfflineStubProvider({ book: { scenarios: BOOK } });
      setAIProviderForTests(model);
    });

    afterEach(() => {
      setAIProviderForTests(null);
      for (const k of ["SUBAGENT_MAX_DEPTH", "SUBAGENT_TOKEN_BUDGET", "CHAT_PROGRESSIVE_SKILLS"]) {
        delete process.env[k];
      }
    });

    // ── #146 — progressive skills ───────────────────────────────────────────
    describe("#146 progressive skill loading", () => {
      it("the prompt grows by name + description only; a body enters ONLY through load_skill — on every request", async () => {
        const skillIds = SKILLS.filter((s) => s.key !== "blocked-skill").map((s) => s.id);
        const sid = await newSession({ projectId: IDS.project, skillIds });
        const res = await send(sid, "SCN-PROGRESSIVE go");
        expect(res.status).toBe(200);
        const reqs = parentRequests("SCN-PROGRESSIVE");
        expect(reqs.length).toBe(2); // the call, and the follow-up carrying its result
        for (const r of reqs) {
          const system = systemText(r.messages);
          expect(toolNames(r)).toContain("load_skill");
          for (const s of SKILLS.filter((x) => x.key !== "blocked-skill")) {
            expect(system).toContain(`- ${s.key}: ${s.name} — ${s.description}`);
            expect(system).not.toContain(bodyMarker(s.key)); // never in the system prompt
          }
        }
        // The one body asked for is in the SECOND request, as a tool result.
        const followUp = JSON.stringify(reqs[1]!.messages.filter((m) => m.role === "tool"));
        expect(followUp).toContain(bodyMarker("style-guide"));
        expect(followUp).not.toContain(bodyMarker("tone"));
        const [part] = await toolParts(sid);
        expect(part).toMatchObject({ name: "load_skill", decision: "auto-approve" });
      });

      it("measures it: N skills add only their catalog lines, where inline mode adds every body", async () => {
        const skillIds = SKILLS.filter((s) => s.key !== "blocked-skill").map((s) => s.id);
        const measure = async (ids: string[], progressive: boolean) => {
          process.env.CHAT_PROGRESSIVE_SKILLS = progressive ? "true" : "false";
          model = new OfflineStubProvider({
            book: { scenarios: [{ match: "SCN-MEASURE", turns: [{ content: "ok" }] }] },
          });
          setAIProviderForTests(model);
          const sid = await newSession({ projectId: IDS.project, skillIds: ids });
          await send(sid, "SCN-MEASURE go");
          return systemText(model.requests[0]!.messages).length;
        };
        const none = await measure([], true);
        const progressive = await measure(skillIds, true);
        const inline = await measure(skillIds, false);
        const catalogBudget = SKILLS.filter((s) => s.key !== "blocked-skill").reduce(
          (n, s) => n + s.key.length + s.name.length + s.description.length + 10,
          0,
        );
        const bodies = skillIds.length * bodyMarker("x").length;
        // Progressive: the fixed header plus one line per skill — no bodies.
        expect(progressive - none).toBeLessThan(catalogBudget + 800);
        expect(inline - none).toBeGreaterThan(bodies);
      });

      it("load_skill respects the project's skill allow-list: a disabled skill is not listed and cannot be loaded", async () => {
        const sid = await newSession({
          projectId: IDS.project,
          skillIds: ["s-style", "s-blocked"],
        });
        await send(sid, "SCN-BLOCKED go");
        const [first] = parentRequests("SCN-BLOCKED");
        expect(systemText(first!.messages)).not.toContain("blocked-skill");
        const tools = (first!.opts.tools ?? []) as Array<{
          name: string;
          parameters: { properties: { name: { enum: string[] } } };
        }>;
        expect(tools.find((t) => t.name === "load_skill")!.parameters.properties.name.enum).toEqual(
          ["style-guide"],
        );
        const [part] = await toolParts(sid);
        expect(String(part!.text)).toContain('no skill named "blocked-skill"');
        expect(String(part!.text)).not.toContain(bodyMarker("blocked-skill"));
      });

      it("…and the project's `disabledSkills` list too: a skill switched off there is neither listed nor loadable", async () => {
        await db.project.update({
          where: { id: IDS.project },
          data: { disabledSkills: JSON.stringify(["style-guide"]) },
        });
        try {
          const sid = await newSession({ projectId: IDS.project, skillIds: ["s-style", "s-tone"] });
          await send(sid, "SCN-PROGRESSIVE go");
          const [first] = parentRequests("SCN-PROGRESSIVE");
          expect(systemText(first!.messages)).not.toContain("style-guide");
          expect(systemText(first!.messages)).toContain("- tone: Tone");
          const [part] = await toolParts(sid);
          expect(String(part!.text)).toContain('no skill named "style-guide"');
          expect(String(part!.text)).not.toContain(bodyMarker("style-guide"));
        } finally {
          await db.project.update({ where: { id: IDS.project }, data: { disabledSkills: "[]" } });
        }
      });

      it("serves a supporting file by exact path, and refuses a traversal path", async () => {
        const sid = await newSession({ projectId: IDS.project, skillIds: ["s-release"] });
        await send(sid, "SCN-FILE go");
        expect(String((await toolParts(sid))[0]!.text)).toContain("TEMPLATE-FILE-MARKER");
        const sid2 = await newSession({ projectId: IDS.project, skillIds: ["s-release"] });
        await send(sid2, "SCN-TRAVERSAL go");
        const [part] = await toolParts(sid2);
        expect(String(part!.text)).toContain("not a valid supporting-file path");
      });

      it("an UNSCOPED session gets load_skill and nothing else (#1368 still holds)", async () => {
        const sid = await newSession({ skillIds: ["s-style"] });
        await send(sid, "SCN-PROGRESSIVE go");
        for (const r of parentRequests("SCN-PROGRESSIVE")) {
          expect(toolNames(r)).toEqual(["load_skill"]);
        }
        expect(countExec).not.toHaveBeenCalled();
      });
    });

    // ── #145 — the one definition, as the session's agent ──────────────────
    describe("#145 the session agent's definition", () => {
      it("the agent's default skill is listed (not pasted), and its approval override tightens the session policy", async () => {
        await db.agent.update({
          where: { id: IDS.lead },
          data: { approvalPolicy: JSON.stringify({ low: "always-prompt" }) },
        });
        try {
          const sid = await newSession({ projectId: IDS.project, agentId: IDS.lead });
          const pending = send(sid, "SCN-PROGRESSIVE go").then((r) => r);
          // load_skill is LOW risk: `auto` for the session, but the agent asks for more.
          const p = await waitForPending(sid);
          expect(p.toolName).toBe("load_skill");
          expect((await decide(sid, p.approvalId, "approve")).status).toBe(200);
          const res = await pending;
          expect(res.status).toBe(200);
          const system = systemText(parentRequests("SCN-PROGRESSIVE")[0]!.messages);
          expect(system).toContain("[agent:lead@1.0.0] Lead");
          expect(system).toContain("- style-guide: Style guide");
          expect(system).not.toContain(bodyMarker("style-guide"));
        } finally {
          await db.agent.update({ where: { id: IDS.lead }, data: { approvalPolicy: null } });
        }
      });

      it("an override can NOT loosen: `auto` on an agent leaves an always-prompt session prompting", async () => {
        await db.agent.update({
          where: { id: IDS.lead },
          data: { approvalPolicy: JSON.stringify({ low: "auto" }) },
        });
        try {
          const sid = await newSession({
            projectId: IDS.project,
            agentId: IDS.lead,
            policy: { low: "always-prompt" },
          });
          const pending = send(sid, "SCN-PROGRESSIVE go").then((r) => r);
          const p = await waitForPending(sid);
          await decide(sid, p.approvalId, "deny");
          await pending;
          const [part] = await toolParts(sid);
          expect(part).toMatchObject({ name: "load_skill", executed: false, decision: "deny" });
        } finally {
          await db.agent.update({ where: { id: IDS.lead }, data: { approvalPolicy: null } });
        }
      });
    });

    // ── #147 — sub-agents ───────────────────────────────────────────────────
    describe("#147 sub-agents", () => {
      it("a sub-agent cannot use a tool outside ITS allowlist even though its caller can; its transcript is stored and linked", async () => {
        const sid = await newSession({
          projectId: IDS.project,
          agentId: IDS.lead,
          policy: { medium: "auto" },
        });
        const res = await send(sid, "SCN-DELEGATE go");
        expect(res.status).toBe(200);

        // The caller had danger_write; the sub-agent was never offered it…
        const parent = parentRequests("SCN-DELEGATE");
        expect(toolNames(parent[0]!)).toEqual(
          expect.arrayContaining(["danger_write", "count_rows"]),
        );
        const sub = subRequests("SUB-HELPER");
        expect(sub.length).toBe(3);
        for (const r of sub) {
          expect(toolNames(r)).toContain("count_rows");
          expect(toolNames(r)).not.toContain("danger_write");
          // …and ran in a FRESH context: its persona and task only, none of the caller's.
          expect(systemText(r.messages)).toContain("You are the helper.");
          expect(systemText(r.messages)).not.toContain("You are the lead.");
          expect(JSON.stringify(r.messages)).not.toContain("SCN-DELEGATE");
          // Its own skills, progressively.
          expect(toolNames(r)).toContain("load_skill");
          expect(systemText(r.messages)).toContain("- release-notes: Release notes");
        }
        // …and naming it anyway is refused as an allowlist denial, never run.
        expect(dangerExec).not.toHaveBeenCalled();
        expect(countExec).toHaveBeenCalledTimes(1);
        const denied = await db.aIToolApproval.findFirst({
          where: { sessionId: sid, toolName: "danger_write" },
        });
        expect(denied).toMatchObject({
          decision: "deny",
          reason: "not_in_agent_allowlist",
          userId: IDS.alice,
        });

        // The parent's transcript links to the stored run…
        const [agentPart] = await toolParts(sid);
        expect(agentPart).toMatchObject({ name: HELPER, decision: "auto-approve" });
        expect(String(agentPart!.text)).toContain("helper done: 7 rows");
        const runId = String(agentPart!.subAgentRunId);
        expect(runId.length).toBeGreaterThan(5);
        // …and the result frame carried the link live.
        const linked = frames(res.text, "tool_event").find((e) => e.subAgentRunId === runId);
        expect(linked).toMatchObject({ phase: "result", name: HELPER });
        // The sub-agent's own tool events are attributed to it.
        expect(
          frames(res.text, "tool_event").some(
            (e) => (e.viaAgent as { name?: string } | undefined)?.name === "Helper",
          ),
        ).toBe(true);

        const run = await as(alice).get(`/api/ai/sessions/${sid}/subagent-runs/${runId}`);
        expect(run.status).toBe(200);
        expect(run.body.data.run).toMatchObject({
          id: runId,
          sessionId: sid,
          parentCallId: "c1",
          agentRef: "custom:c-helper",
          agentName: "Helper",
          depth: 1,
          status: "completed",
          result: "helper done: 7 rows",
          task: "SUB-HELPER please count table t",
        });
        expect(
          run.body.data.run.toolCalls.map((c: { tool: string; executed: boolean }) => [
            c.tool,
            c.executed,
          ]),
        ).toEqual([
          ["danger_write", false],
          ["count_rows", true],
        ]);
        expect(run.body.data.run.usage.totalTokens).toBeGreaterThan(0);
      });

      it("a stored run is readable only through its own session by its owner", async () => {
        const sid = await newSession({
          projectId: IDS.project,
          agentId: IDS.lead,
          policy: { medium: "auto" },
        });
        await send(sid, "SCN-DELEGATE go");
        const runId = String((await toolParts(sid))[0]!.subAgentRunId);
        expect((await as(bob).get(`/api/ai/sessions/${sid}/subagent-runs/${runId}`)).status).toBe(
          404,
        );
        const other = await newSession({ projectId: IDS.project });
        expect(
          (await as(alice).get(`/api/ai/sessions/${other}/subagent-runs/${runId}`)).status,
        ).toBe(404);
      });

      it("a sub-agent's tool that needs approval asks the SAME session's owner — denied, it never runs", async () => {
        const sid = await newSession({
          projectId: IDS.project,
          policy: { medium: "auto", high: "always-prompt" },
        });
        const pending = send(sid, "SCN-WRITER go").then((r) => r);
        const p = await waitForPending(sid);
        expect(p.toolName).toBe("danger_write");
        // Nobody else can answer it.
        expect(
          (
            await as(bob).post(`/api/ai/sessions/${sid}/approvals/${p.approvalId}`, {
              decision: "approve",
            })
          ).status,
        ).not.toBe(200);
        await decide(sid, p.approvalId, "deny");
        const res = await pending;
        expect(res.status).toBe(200);
        expect(dangerExec).not.toHaveBeenCalled();
        const row = await db.aIToolApproval.findFirst({
          where: { sessionId: sid, toolName: "danger_write" },
        });
        expect(row).toMatchObject({ decision: "deny", reason: "user_denied", userId: IDS.alice });
        // The approval prompt reached the caller's stream, attributed to the sub-agent.
        const ask = frames(res.text, "tool_event").find((e) => e.phase === "awaiting_approval");
        expect(ask).toMatchObject({ name: "danger_write", viaAgent: { name: "Writer", depth: 1 } });
      });

      it("…and approved, it runs exactly once", async () => {
        const sid = await newSession({
          projectId: IDS.project,
          policy: { medium: "auto", high: "always-prompt" },
        });
        const pending = send(sid, "SCN-WRITER go").then((r) => r);
        const p = await waitForPending(sid);
        await decide(sid, p.approvalId, "approve");
        await pending;
        expect(dangerExec).toHaveBeenCalledTimes(1);
      });

      it("the sub-agent CALL itself passes the gate: denied, the agent never runs", async () => {
        const sid = await newSession({
          projectId: IDS.project,
          policy: { medium: "always-prompt" },
        });
        const pending = send(sid, "SCN-DELEGATE go").then((r) => r);
        const p = await waitForPending(sid);
        expect(p.toolName).toBe(HELPER);
        await decide(sid, p.approvalId, "deny");
        await pending;
        expect(subRequests("SUB-HELPER")).toHaveLength(0);
        expect(await db.aISubAgentRun.count({ where: { sessionId: sid } })).toBe(0);
        const [part] = await toolParts(sid);
        expect(part).toMatchObject({ name: HELPER, executed: false, decision: "deny" });
      });

      it("depth: with SUBAGENT_MAX_DEPTH=1 a sub-agent is offered no agents, and naming one gets nothing run", async () => {
        process.env.SUBAGENT_MAX_DEPTH = "1";
        const sid = await newSession({ projectId: IDS.project, policy: { medium: "auto" } });
        await send(sid, "SCN-NEST go");
        for (const r of subRequests("SUB-NEST")) {
          expect(toolNames(r).some((n) => n.startsWith("agent_"))).toBe(false);
        }
        expect(subRequests("SUB-HELPER")).toHaveLength(0);
        const runs = await db.aISubAgentRun.findMany({ where: { sessionId: sid } });
        expect(runs.map((r) => r.depth)).toEqual([1]);
      });

      it("depth: at the default (2) the nested call runs, recorded under its parent run", async () => {
        const sid = await newSession({ projectId: IDS.project, policy: { medium: "auto" } });
        await send(sid, "SCN-NEST go");
        const runs = await db.aISubAgentRun.findMany({
          where: { sessionId: sid },
          orderBy: { depth: "asc" },
        });
        expect(runs.map((r) => [r.agentName, r.depth])).toEqual([
          ["Writer", 1],
          ["Helper", 2],
        ]);
        expect(runs[1]!.parentRunId).toBe(runs[0]!.id);
        // The Helper at depth 2 (== the limit) is offered no further agents.
        for (const r of subRequests("SUB-HELPER")) {
          expect(toolNames(r).some((n) => n.startsWith("agent_"))).toBe(false);
        }
      });

      it("the token budget: once the reply's sub-agents have spent it, the next one does not run — recorded", async () => {
        process.env.SUBAGENT_TOKEN_BUDGET = "100";
        const sid = await newSession({ projectId: IDS.project, policy: { medium: "auto" } });
        await send(sid, "SCN-BUDGET go");
        expect(subRequests("SUB-BIG")).toHaveLength(1);
        const runs = await db.aISubAgentRun.findMany({
          where: { sessionId: sid },
          orderBy: { createdAt: "asc" },
        });
        expect(runs.map((r) => r.status)).toEqual(["completed", "budget_exhausted"]);
        const parts = await toolParts(sid);
        expect(String(parts[1]!.text)).toContain("token budget");
      });

      it("an agent of ANOTHER project is never offered, and naming it runs nothing", async () => {
        const sid = await newSession({ projectId: IDS.project, policy: { medium: "auto" } });
        await send(sid, "SCN-OUTSIDER go");
        const [first] = parentRequests("SCN-OUTSIDER");
        expect(toolNames(first!).some((n) => n.includes("outsider"))).toBe(false);
        expect(await db.aISubAgentRun.count({ where: { sessionId: sid } })).toBe(0);
        const [part] = await toolParts(sid);
        expect(part).toMatchObject({ executed: false, errorCode: "TOOL_UNKNOWN" });
      });
    });
  },
);
