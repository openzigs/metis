/**
 * Epic #260 — Custom Analyst Agents UI flows.
 *
 * Covers the two user-facing surfaces shipped on `feat/epic-260-custom-agents`
 * (UI commit 94f81a8):
 *
 *   #84 — authoring wizard at `/workspaces/:id/agents/new`. A coordinator walks
 *         the multi-step flow (name → prompt+template → tools → model →
 *         playground), runs the playground, and sees a sample completion.
 *   #85 — per-project enablement card on `/projects/:id`. Candidate custom
 *         agents render with Enable/Disable toggles that live-update when
 *         clicked.
 *
 * Parent epic #77 AC #1: "a coordinator opens the wizard, fills name/prompt/
 * tools/model, runs the playground, and sees a sample completion."
 *
 * Determinism / mocking strategy
 * ------------------------------
 * The wizard's playground POSTs `/api/custom-agents/:id/invoke`, which on the
 * server runs through the configured AI provider. The e2e stack uses the
 * `offline-stub` provider (see `playwright.config.ts`), so a live LLM is never
 * contacted. To keep the *assertion surface* deterministic and decoupled from
 * the stub's exact output shape — and to mirror the route-interception
 * convention used by `db-connector-wizard.spec.ts` — the agent-create and
 * invoke calls are stubbed via `page.route`. Enablement toggles are likewise
 * intercepted so we can assert the live-update behaviour without depending on
 * server-side workspace-admin RBAC for the mock user.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { AgentWizardPage, CustomAgentsEnablementSection } from "../pages/custom-agents.page.js";

const API_BASE = apiBase();

interface SeededContext {
  accessToken: string;
  workspaceId: string;
  projectId: string;
}

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Create a fresh workspace + project so the wizard's project dropdown
 * populates and `/projects/:id` resolves. Returns the ids the UI routes need.
 */
async function seedWorkspaceAndProject(token: string): Promise<{
  workspaceId: string;
  projectId: string;
}> {
  const api = await authedApi(token);
  try {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const wsRes = await api.post("/api/workspaces", {
      data: { name: `CA WS ${stamp}`, slug: `ca-ws-${stamp}` },
    });
    expect(wsRes.status()).toBe(201);
    const wsBody = (await wsRes.json()) as { data: { id: string } };
    const workspaceId = wsBody.data.id;

    const projRes = await api.post("/api/projects", {
      data: {
        name: `CA Project ${stamp}`,
        slug: `ca-project-${stamp}`,
        description: "epic-260 custom agents e2e",
        workspaceId,
      },
    });
    expect([200, 201]).toContain(projRes.status());
    const projBody = (await projRes.json()) as {
      data?: { id?: string; project?: { id?: string } };
    };
    const projectId = projBody.data?.id ?? projBody.data?.project?.id;
    if (!projectId) throw new Error(`Malformed project response: ${JSON.stringify(projBody)}`);

    return { workspaceId, projectId };
  } finally {
    await api.dispose();
  }
}

test.describe("Epic #260 — Custom Analyst Agents", () => {
  test.describe.configure({ timeout: 120_000 });

  let ctx: SeededContext;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    const seeded = await seedWorkspaceAndProject(primed.accessToken);
    ctx = { accessToken: primed.accessToken, ...seeded };

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // ───────────────────────────────────────────────────────────────────────
  // #84 — authoring wizard
  // ───────────────────────────────────────────────────────────────────────
  test.describe("Authoring wizard (#84)", () => {
    // AC (#84 / epic #77 #1): a coordinator opens the wizard, fills name /
    // prompt / tools / model, runs the playground, and sees a sample
    // completion. Exercises the full multi-step flow + completion render.
    test("walks name → prompt → tools → model → playground and renders a completion", async ({
      page,
    }) => {
      const AGENT_ID = "agent_e2e_84";
      const COMPLETION = "Sample analysis: three requirements extracted, one ambiguity flagged.";

      // Stub the draft-create POST so the playground has an id to invoke.
      await page.route("**/api/custom-agents", (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: { id: AGENT_ID, name: "Compliance Reviewer", projectId: ctx.projectId },
          }),
        });
      });
      // Stub the invocation so the completion render is deterministic.
      await page.route(`**/api/custom-agents/${AGENT_ID}/invoke`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              content: COMPLETION,
              model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
              provider: "offline-stub",
              usage: { promptTokens: 42, completionTokens: 18, totalTokens: 60 },
            },
          }),
        }),
      );

      const wizard = new AgentWizardPage(page);
      await wizard.goto(ctx.workspaceId);

      await test.step("Step 1 — name + project", async () => {
        await expect(wizard.stepPanel("name")).toBeVisible();
        await wizard.nameInput.fill("Compliance Reviewer");
        await wizard.descriptionInput.fill("Flags compliance risks in specs.");
        // The project dropdown is populated from the seeded workspace.
        await expect(wizard.projectSelect.locator("option", { hasText: "CA Project" })).toHaveCount(
          1,
        );
        await wizard.projectSelect.selectOption(ctx.projectId);
        await wizard.next();
      });

      await test.step("Step 2 — prompt via template gallery", async () => {
        await expect(wizard.stepPanel("prompt")).toBeVisible();
        await expect(wizard.templateGallery).toBeVisible();
        // Choosing a template fills the system prompt.
        await wizard.templateButton("requirements-analyst").click();
        await expect(wizard.promptInput).not.toHaveValue("");
        await wizard.next();
      });

      await test.step("Step 3 — tool picker", async () => {
        await expect(wizard.stepPanel("tools")).toBeVisible();
        const knowledge = wizard.toolCheckbox("knowledge_search");
        const readDoc = wizard.toolCheckbox("read_document");
        await knowledge.check();
        await readDoc.check();
        await expect(knowledge).toBeChecked();
        await expect(readDoc).toBeChecked();
        await wizard.next();
      });

      await test.step("Step 4 — model + reasoning picker", async () => {
        await expect(wizard.stepPanel("model")).toBeVisible();
        await wizard.modelSelect.selectOption("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
        await wizard.reasoningSelect.selectOption("medium");
        await wizard.next();
      });

      await test.step("Step 5 — run playground and see completion", async () => {
        await expect(wizard.stepPanel("playground")).toBeVisible();
        // Run is disabled until there is input.
        await expect(wizard.playgroundRun).toBeDisabled();
        await wizard.playgroundInput.fill("Analyze the attached requirements document.");
        await expect(wizard.playgroundRun).toBeEnabled();
        await wizard.playgroundRun.click();

        await expect(wizard.playgroundOutput).toBeVisible();
        await expect(wizard.playgroundOutput).toContainText(COMPLETION);
        await expect(wizard.playgroundOutput).toContainText("60 tokens");
        await expect(wizard.playgroundError).toBeHidden();
      });
    });

    // AC (#84): the multi-step flow gates progress — Next is blocked until the
    // current step's required fields are valid, and Back returns to prior steps.
    test("gates Next until required fields are filled and supports Back navigation", async ({
      page,
    }) => {
      const wizard = new AgentWizardPage(page);
      await wizard.goto(ctx.workspaceId);

      await test.step("Next is disabled on an empty name step", async () => {
        await expect(wizard.stepPanel("name")).toBeVisible();
        await expect(wizard.nextButton).toBeDisabled();
      });

      await test.step("Name alone is insufficient — a project is also required", async () => {
        await wizard.nameInput.fill("Risk Reviewer");
        await expect(wizard.nextButton).toBeDisabled();
      });

      await test.step("Selecting a project enables Next", async () => {
        await wizard.projectSelect.selectOption(ctx.projectId);
        await expect(wizard.nextButton).toBeEnabled();
        await wizard.next();
      });

      await test.step("Prompt step blocks Next until a prompt exists", async () => {
        await expect(wizard.stepPanel("prompt")).toBeVisible();
        await expect(wizard.nextButton).toBeDisabled();
        await wizard.templateButton("risk-reviewer").click();
        await expect(wizard.nextButton).toBeEnabled();
      });

      await test.step("Back returns to the name step with values preserved", async () => {
        await wizard.back();
        await expect(wizard.stepPanel("name")).toBeVisible();
        await expect(wizard.nameInput).toHaveValue("Risk Reviewer");
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // #85 — per-project enablement toggle
  // ───────────────────────────────────────────────────────────────────────
  test.describe("Per-project enablement (#85)", () => {
    const AGENT_A = "agent_builtin_req";
    const AGENT_B = "agent_proj_risk";

    /** Candidate agents shown as rows (built-in + project-owned). */
    function candidatesBody(projectId: string) {
      return {
        success: true,
        data: [
          {
            id: AGENT_A,
            name: "Requirements Analyst",
            description: "Built-in requirements specialist.",
            isBuiltIn: true,
            projectId: null,
          },
          {
            id: AGENT_B,
            name: "Risk Reviewer",
            description: "Project-owned risk agent.",
            isBuiltIn: false,
            projectId,
          },
        ],
      };
    }

    // AC (#85): the settings page lists candidate custom agents with
    // enable/disable buttons.
    test("lists candidate agents with Enable/Disable controls", async ({ page }) => {
      await page.route("**/api/custom-agents?*", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(candidatesBody(ctx.projectId)),
        }),
      );
      // No agents enabled yet → both rows render "Enable".
      await page.route(`**/api/custom-agents/projects/${ctx.projectId}/enabled`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: [] }),
        }),
      );

      const section = new CustomAgentsEnablementSection(page);
      await section.goto(ctx.projectId);

      await expect(section.heading).toBeVisible();
      await expect(section.row(AGENT_A)).toBeVisible();
      await expect(section.row(AGENT_B)).toBeVisible();
      await expect(section.row(AGENT_A)).toContainText("Requirements Analyst");
      await expect(section.row(AGENT_A)).toContainText("built-in");

      // Neither is enabled → both toggles read "Enable" / aria-pressed=false.
      await expect(section.toggle(AGENT_A)).toHaveText("Enable");
      await expect(section.toggle(AGENT_A)).toHaveAttribute("aria-pressed", "false");
      await expect(section.toggle(AGENT_B)).toHaveText("Enable");
    });

    // AC (#85): toggling live-updates — clicking Enable PUTs the enablement and
    // the row label flips to "Disable" (aria-pressed=true) after the enabled
    // set refetches.
    test("toggling an agent live-updates the row label", async ({ page }) => {
      // Mutable server-side enabled set the stubbed endpoints share.
      let enabledIds: string[] = [];

      await page.route("**/api/custom-agents?*", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(candidatesBody(ctx.projectId)),
        }),
      );
      await page.route(`**/api/custom-agents/projects/${ctx.projectId}/enabled`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: enabledIds.map((id) => ({ id, name: id, isBuiltIn: false, projectId: null })),
          }),
        }),
      );
      // PUT enablement flips the shared set so the subsequent refetch reflects it.
      await page.route("**/api/custom-agents/*/enablement", async (route) => {
        const req = route.request();
        if (req.method() !== "PUT") return route.fallback();
        const body = req.postDataJSON() as { enabled: boolean };
        const url = new URL(req.url());
        const id = url.pathname.split("/").slice(-2, -1)[0]!;
        if (body.enabled) {
          if (!enabledIds.includes(id)) enabledIds = [...enabledIds, id];
        } else {
          enabledIds = enabledIds.filter((x) => x !== id);
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              id: "en_1",
              customAgentId: id,
              projectId: ctx.projectId,
              enabled: body.enabled,
              enabledById: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }),
        });
      });

      const section = new CustomAgentsEnablementSection(page);
      await section.goto(ctx.projectId);

      await test.step("Agent starts disabled", async () => {
        await expect(section.toggle(AGENT_A)).toHaveText("Enable");
        await expect(section.toggle(AGENT_A)).toHaveAttribute("aria-pressed", "false");
      });

      await test.step("Enabling flips the label to Disable", async () => {
        await section.toggle(AGENT_A).click();
        await expect(section.toggle(AGENT_A)).toHaveText("Disable");
        await expect(section.toggle(AGENT_A)).toHaveAttribute("aria-pressed", "true");
      });

      await test.step("Disabling flips it back to Enable", async () => {
        await section.toggle(AGENT_A).click();
        await expect(section.toggle(AGENT_A)).toHaveText("Enable");
        await expect(section.toggle(AGENT_A)).toHaveAttribute("aria-pressed", "false");
      });
    });

    // AC (#85): empty state when there are no candidate agents.
    test("shows the empty state when no custom agents are available", async ({ page }) => {
      await page.route("**/api/custom-agents?*", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: [] }),
        }),
      );
      await page.route(`**/api/custom-agents/projects/${ctx.projectId}/enabled`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: [] }),
        }),
      );

      const section = new CustomAgentsEnablementSection(page);
      await section.goto(ctx.projectId);
      await expect(section.empty).toBeVisible();
    });
  });
});
