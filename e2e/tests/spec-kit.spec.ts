/**
 * Epic #193 — Spec Kit Mode end-to-end coverage.
 *
 * Walks the full operator path against the seeded admin token:
 *   1. Create a project + enable Spec Kit Mode.
 *   2. Run `/specify`, verify `spec.md` lands in the artifact list.
 *   3. Run `/plan`, verify `plan.md` appears.
 *   4. Run `/tasks`, verify `tasks.md` appears.
 *   5. Run `/implement`, verify the orchestrator handoff payload.
 *   6. Confirm `/files` reflects the full set, sized > 0, in version 1.
 *
 * AI calls hit the offline stub provider (server-side `AI_OFFLINE=1`),
 * so the runs are deterministic + free.
 */
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user";
import { apiBase } from "../fixtures/api-base";
import { createProjectViaApi } from "../fixtures/project-helpers";
import { LoginPage } from "../pages/login.page";
import { ProjectTabsPage } from "../pages/project-tabs.page";
import { SpecKitPage } from "../pages/SpecKit.page";

const API_BASE = apiBase();

interface Envelope<T> {
  success: boolean;
  data: T;
}

async function adminContext(): Promise<APIRequestContext> {
  const { accessToken } = await primeAdminUser(API_BASE);
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
  });
}

test.describe("Epic #193 — Spec Kit Mode", () => {
  test("full slash-command pipeline: enable → /specify → /plan → /tasks → /implement", async () => {
    const ctx = await adminContext();
    try {
      const slug = `e2e-spec-kit-${Date.now()}`;
      const created = await ctx.post("/api/projects", {
        data: { name: `Spec Kit ${slug}`, slug, description: "epic-193" },
      });
      expect(created.status(), await created.text()).toBe(201);
      const projectId = (await created.json()).data.id as string;

      // Enable Spec Kit Mode.
      const enabledRes = await ctx.put(`/api/projects/${projectId}/spec-kit/enabled`, {
        data: { enabled: true },
      });
      expect(enabledRes.status(), await enabledRes.text()).toBe(200);
      expect(((await enabledRes.json()) as Envelope<{ enabled: boolean }>).data.enabled).toBe(true);

      // /specify
      const specifyRes = await ctx.post(`/api/projects/${projectId}/spec-kit/commands/specify`, {
        data: { input: "build a billing dashboard with three KPI tiles" },
      });
      expect(specifyRes.status(), await specifyRes.text()).toBe(200);
      const specifyBody = (await specifyRes.json()) as Envelope<{
        command: string;
        artifactName: string | null;
      }>;
      expect(specifyBody.data.command).toBe("specify");
      expect(specifyBody.data.artifactName).toBe("spec.md");

      // /plan
      const planRes = await ctx.post(`/api/projects/${projectId}/spec-kit/commands/plan`, {
        data: { input: "" },
      });
      expect(planRes.status(), await planRes.text()).toBe(200);
      expect(
        ((await planRes.json()) as Envelope<{ artifactName: string | null }>).data.artifactName,
      ).toBe("plan.md");

      // /tasks
      const tasksRes = await ctx.post(`/api/projects/${projectId}/spec-kit/commands/tasks`, {
        data: { input: "" },
      });
      expect(tasksRes.status(), await tasksRes.text()).toBe(200);
      expect(
        ((await tasksRes.json()) as Envelope<{ artifactName: string | null }>).data.artifactName,
      ).toBe("tasks.md");

      // /implement (no AI call — pure handoff)
      const implRes = await ctx.post(`/api/projects/${projectId}/spec-kit/commands/implement`, {
        data: { input: "" },
      });
      expect(implRes.status(), await implRes.text()).toBe(200);
      const implBody = (await implRes.json()) as Envelope<{
        command: string;
        artifactName: string | null;
        artifact: { context: string[]; orchestratorRoute: string };
      }>;
      expect(implBody.data.command).toBe("implement");
      expect(implBody.data.artifactName).toBeNull();
      expect(implBody.data.artifact.orchestratorRoute).toContain(
        `/api/projects/${projectId}/analyses`,
      );
      expect(implBody.data.artifact.context).toEqual(
        expect.arrayContaining(["spec.md", "plan.md", "tasks.md"]),
      );

      // Final list — all three artifacts present, version 1, content > 0.
      const filesRes = await ctx.get(`/api/projects/${projectId}/spec-kit/files`);
      expect(filesRes.status()).toBe(200);
      const filesBody = (await filesRes.json()) as Envelope<{
        enabled: boolean;
        artifacts: Array<{ name: string; version: number; content: string }>;
      }>;
      expect(filesBody.data.enabled).toBe(true);
      const byName = new Map(filesBody.data.artifacts.map((a) => [a.name, a]));
      for (const name of ["spec.md", "plan.md", "tasks.md"]) {
        const a = byName.get(name);
        expect(a, `${name} should exist`).toBeTruthy();
        expect(a!.version).toBeGreaterThanOrEqual(1);
        expect(a!.content.length).toBeGreaterThan(0);
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("commands are gated by the enabled flag (409 when disabled)", async () => {
    const ctx = await adminContext();
    try {
      const slug = `e2e-spec-kit-disabled-${Date.now()}`;
      const created = await ctx.post("/api/projects", {
        data: { name: `Spec Kit ${slug}`, slug, description: "epic-193" },
      });
      const projectId = (await created.json()).data.id as string;

      const res = await ctx.post(`/api/projects/${projectId}/spec-kit/commands/specify`, {
        data: { input: "anything" },
      });
      expect(res.status()).toBe(409);
      expect((await res.json()).error.code).toBe("SPEC_KIT_DISABLED");
    } finally {
      await ctx.dispose();
    }
  });

  test("manual writes round-trip through GET/PUT /files/:name", async () => {
    const ctx = await adminContext();
    try {
      const slug = `e2e-spec-kit-manual-${Date.now()}`;
      const created = await ctx.post("/api/projects", {
        data: { name: `Spec Kit ${slug}`, slug, description: "epic-193" },
      });
      const projectId = (await created.json()).data.id as string;
      await ctx.put(`/api/projects/${projectId}/spec-kit/enabled`, { data: { enabled: true } });

      const wrote = await ctx.put(`/api/projects/${projectId}/spec-kit/files/spec.md`, {
        data: { content: "# Spec\nManual override.\n" },
      });
      expect(wrote.status()).toBe(200);

      const read = await ctx.get(`/api/projects/${projectId}/spec-kit/files/spec.md`);
      expect(read.status()).toBe(200);
      const body = (await read.json()) as Envelope<{
        artifact: { content: string; version: number };
      }>;
      expect(body.data.artifact.content).toContain("Manual override.");
      expect(body.data.artifact.version).toBe(1);
    } finally {
      await ctx.dispose();
    }
  });

  test("requires authentication", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    const res = await ctx.get("/api/projects/whatever/spec-kit/enabled");
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });
});

test.describe.configure({ mode: "parallel" });

/**
 * Epic #370, Phase 4 (#377) — verify the Spec Kit *repositioning* (S1/S2) and
 * BA/PM framing through the real UI, not just the API surface.
 *
 *   - Spec Kit is reachable as a PRIMARY tab beside Analysis, NOT inside the
 *     "Docs" group dropdown.
 *   - The page reads as the BA/PM "author the intent" front-door (header
 *     subtitle + empty-state onboarding copy), and links to Analysis as the
 *     downstream consumer.
 *   - The canonical URL `/projects/:id/spec-kit` is UNCHANGED, so there is NO
 *     legacy redirect to assert; instead we GUARD that the route stays
 *     directly reachable (a redirect would only be needed if the path had
 *     moved — it did not).
 *
 * These run against the offline-stub provider (server `AI_OFFLINE=1`), under
 * the seeded admin user (mock auth), so they are deterministic and free.
 */
test.describe("Epic #370 Phase 4 — Spec Kit placement & BA/PM framing (#377)", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    const project = await createProjectViaApi(API_BASE, primed.accessToken);
    projectId = project.id;
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // #28 moved Spec Kit under Analyze (beside Requirements Analysis) — still a
  // planning surface, still not documentation.
  test("Spec Kit sits under Analyze beside Requirements Analysis, not under Docs", async ({
    page,
  }) => {
    const tabs = new ProjectTabsPage(page);
    await page.goto(`/projects/${projectId}/analysis`, { waitUntil: "load" });
    await tabs.expectVisible();

    await expect(
      page.getByRole("navigation", { name: "Analyze pages" }).getByRole("link"),
    ).toHaveText(["Requirements Analysis", "Impact Analysis", "Spec Kit"]);

    await tabs.primaryLink("Docs").click();
    await expect(page.getByRole("navigation", { name: "Docs pages" }).getByRole("link")).toHaveText(
      ["Documentation", "Templates"],
    );
  });

  test("clicking the Spec Kit link opens the canonical /spec-kit route (no redirect)", async ({
    page,
  }) => {
    const specKit = new SpecKitPage(page);
    await specKit.openViaPrimaryTab(projectId);
    // Canonical URL is unchanged — the tab lands directly on /spec-kit with no
    // intermediate legacy redirect. This is the guard the AC asks for in lieu
    // of a (non-existent) redirect. A predicate (not a dynamic RegExp) keeps
    // the Semgrep detect-non-literal-regexp gate quiet.
    await expect(page).toHaveURL((url) => url.pathname === `/projects/${projectId}/spec-kit`);
    await expect(specKit.specKitTab).toHaveAttribute("aria-current", "page");
  });

  test("the page frames Spec Kit as the BA/PM author-the-intent front-door", async ({ page }) => {
    const specKit = new SpecKitPage(page);
    await specKit.openViaPrimaryTab(projectId);

    // Header subtitle: BA/PM front-door, spec → plan → tasks, links to Analysis.
    await expect(specKit.subtitle).toContainText(/BA\/PM front-door/i);
    await expect(specKit.subtitle).toContainText(/spec → plan → tasks/i);
    await expect(page.getByTestId("spec-kit-subtitle-analysis-link")).toHaveAttribute(
      "href",
      `/projects/${projectId}/analysis`,
    );

    // Enable Spec Kit, then the empty-state onboarding explains the authoring
    // flow and that the Analysis handoff is MANUAL (no auto-run of /implement).
    await specKit.enable();
    await expect(specKit.onboarding).toBeVisible();
    await expect(specKit.onboarding).toContainText(/author the intent/i);
    await expect(specKit.onboarding).toContainText(/This handoff is manual/i);
    await expect(page.getByTestId("spec-kit-analysis-link")).toHaveAttribute(
      "href",
      `/projects/${projectId}/analysis`,
    );
  });
});

// Username-export workaround for editor type-checks of unused symbol.
void ADMIN_USER;
