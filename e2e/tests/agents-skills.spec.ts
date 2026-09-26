/**
 * Epic #129 / #148 — agents and skills, end to end.
 *
 * AC: create an agent with a skill and a tool allowlist → chat with it → the
 * skill is loaded ON DEMAND, an allowed tool runs (with approval), and a
 * disallowed tool is refused.
 *
 * The model is the OFFLINE STUB driven by a committed script book
 * (`e2e/fixtures/agents/script-book.json`, #148): the stub makes REAL native
 * tool calls (load_skill → score_grounding → inspect_schema → answer), and
 * everything after the model — the tool runtime, the approval gate, the broker,
 * the chat page's Approve buttons, the transcript — is the production code.
 *
 * The script book only switches on when the stack is booted with
 * `AI_OFFLINE_SCRIPT_FILE` (and `AI_REPLAY=0`); the CI `generative-e2e` job runs
 * this spec that way. Anywhere else it skips with that reason.
 *
 * A manual smoke against a real local model (Ollama) is documented in
 * docs/USER_GUIDE.md ("Agents and skills — local-model smoke run").
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { createProjectViaApi } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { AgentChatPage } from "../pages/agent-chat.page.js";

const API_BASE = apiBase();
const SCRIPTED = Boolean(process.env.AI_OFFLINE_SCRIPT_FILE);
const MARKER = "E2E-AGENTS-SKILLS-148";
const SKILL_KEY = "e2e-release-notes";
const SKILL_BODY_MARKER = "SKILL-BODY-7f3a: list every user-visible change";

async function api(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

interface Part {
  type: string;
  name?: string;
  text?: string;
  executed?: boolean;
  decision?: string;
  errorCode?: string;
}

test.describe("Epic #129 — agents and skills (#148)", () => {
  test.skip(
    !SCRIPTED,
    "Needs the scripted offline stub: boot the stack with AI_OFFLINE_SCRIPT_FILE=e2e/fixtures/agents/script-book.json AI_REPLAY=0 (the generative-e2e CI job does).",
  );
  test.describe.configure({ timeout: 120_000 });

  test("an agent's skill loads on demand, an allowed tool runs with approval, a disallowed one is refused", async ({
    page,
  }) => {
    const primed = await primeAdminUser(API_BASE);
    const client = await api(primed.accessToken);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const agentKey = `e2e-scribe-${stamp}`;
    let projectId = "";
    try {
      await test.step("seed a skill, an agent that carries it, and a project", async () => {
        const skill = await client.post("/api/skills", {
          data: {
            key: SKILL_KEY,
            source: [
              "---",
              `name: ${SKILL_KEY}`,
              "description: Draft release notes from a change list. Use when asked for release notes.",
              "---",
              `# Release notes\n\n${SKILL_BODY_MARKER}.`,
            ].join("\n"),
          },
        });
        // 409 = an earlier run in this stack already created it (same content).
        expect([201, 409]).toContain(skill.status());

        const agent = await client.post("/api/agents", {
          data: {
            key: agentKey,
            defaultSkillKeys: [SKILL_KEY],
            source: [
              "---",
              `name: ${agentKey}`,
              "description: Writes release notes.",
              "tools:",
              "  - score_grounding",
              "approvalPolicy:",
              "  low: always-prompt",
              "---",
              "You write concise release notes.",
            ].join("\n"),
          },
        });
        expect(agent.status(), await agent.text()).toBe(201);
        projectId = (await createProjectViaApi(API_BASE, primed.accessToken, "e2e-agents")).id;
      });

      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);

      const chat = new AgentChatPage(page);
      await chat.gotoProjectChat(projectId);
      const sessionId = await chat.pickAgent(agentKey);

      await test.step("chat: the skill is loaded on demand (with approval)", async () => {
        await chat.send(`${MARKER} please draft the release notes`);
        // The agent's approval override (low: always-prompt) applies to its
        // own load_skill call too — nothing runs unapproved.
        await expect(chat.toolRow("load_skill")).toContainText("waiting for your approval");
        await chat.approve("load_skill");
        await expect(chat.toolRow("load_skill")).toContainText("done");
      });

      await test.step("an allowed tool waits for approval, then runs", async () => {
        await expect(chat.toolRow("score_grounding")).toContainText("waiting for your approval");
        await chat.approve("score_grounding");
        await expect(chat.toolRow("score_grounding")).toContainText("done");
      });

      await test.step("a tool outside the agent's allowlist is refused", async () => {
        await expect(chat.toolRow("inspect_schema")).toContainText(
          "Not allowed for this agent — the tool did not run.",
        );
        await expect(
          chat.assistantText("E2E-DONE: release notes drafted from the skill."),
        ).toBeVisible();
      });

      await test.step("the transcript and the approval log record every decision", async () => {
        const transcript = await client.get(`/api/ai/sessions/${sessionId}/messages`);
        expect(transcript.status()).toBe(200);
        const body = (await transcript.json()) as {
          data: { messages: Array<{ role: string; parts: Part[] }> };
        };
        const results = body.data.messages
          .filter((m) => m.role === "assistant")
          .flatMap((m) => m.parts)
          .filter((p) => p.type === "tool_result");
        const byName = new Map(results.map((p) => [p.name, p]));
        // The body entered the context only through the load_skill call.
        expect(byName.get("load_skill")?.text).toContain(SKILL_BODY_MARKER);
        expect(byName.get("load_skill")).toMatchObject({ decision: "approve" });
        expect(byName.get("score_grounding")).toMatchObject({ decision: "approve" });
        expect(byName.get("score_grounding")?.executed).not.toBe(false);
        expect(byName.get("inspect_schema")).toMatchObject({
          executed: false,
          errorCode: "TOOL_NOT_ALLOWED",
        });

        const approvals = await client.get(`/api/ai/sessions/${sessionId}/approvals`);
        const rows = (
          (await approvals.json()) as {
            data: { rows: Array<{ toolName: string; decision: string; reason: string | null }> };
          }
        ).data.rows;
        expect(rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ toolName: "load_skill", decision: "approve" }),
            expect.objectContaining({ toolName: "score_grounding", decision: "approve" }),
            expect.objectContaining({
              toolName: "inspect_schema",
              decision: "deny",
              reason: "not_in_agent_allowlist",
            }),
          ]),
        );
      });
    } finally {
      await client.dispose();
    }
  });
});
