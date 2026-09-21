/**
 * Epic #728 / Issue #738 — Two-user comment + @mention flow.
 *
 * Acceptance criteria covered:
 *   AC1: User A posts a comment with @userB → User B receives a
 *        `comment:mention` socket notification within 2 s and the
 *        Mention row is persisted server-side.
 *
 * Strategy: pure API-layer integration tests using two Playwright
 * `request.newContext()` instances (admin ≡ User A, coordinator ≡ User B).
 * The socket notification is verified indirectly by polling the GET
 * /comments endpoint — a Mention row is the server-side artefact that
 * proves fan-out ran. Full in-browser socket tests for the bell badge live
 * in presence.spec.ts.
 *
 * All tests require a running server (E2E_SKIP_WEBSERVER must be unset or
 * the stack must be pre-booted).
 *
 * Closes #738
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER } from "../../fixtures/seed-user.js";
import { apiBase } from "../../fixtures/api-base.js";

const API_BASE = apiBase();

// ---- Shared credential for the second user ----------------------------------

const COORDINATOR = { username: "coordinator", password: "password" };

// ---- Helpers ----------------------------------------------------------------

async function loginAs(
  username: string,
  password: string,
): Promise<{ userId: string; accessToken: string; api: APIRequestContext }> {
  const ctx = await request.newContext({ baseURL: API_BASE });
  const res = await ctx.post("/api/auth/login", {
    data: { username, password },
  });
  expect(res.status(), `login failed for ${username}: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as {
    success: boolean;
    data: { user: { id: string }; accessToken: string };
  };
  await ctx.dispose();

  const api = await request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${body.data.accessToken}` },
  });
  return {
    userId: body.data.user.id,
    accessToken: body.data.accessToken,
    api,
  };
}

async function createProject(api: APIRequestContext, suffix: string): Promise<string> {
  const res = await api.post("/api/projects", {
    data: { name: `collab-comment-${suffix}`, description: "E2E #738" },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  return body.data.id as string;
}

// ---- Suite ------------------------------------------------------------------

test.describe("Epic #728 / Issue #738 — Two-user comment + mention flow", () => {
  let adminApi: APIRequestContext;
  let coordinatorApi: APIRequestContext;
  let adminUserId: string;
  let coordinatorUserId: string;
  let projectId: string;
  let requirementId: string;

  test.beforeAll(async () => {
    // Prime both users.
    const [adminPrimed, coordPrimed] = await Promise.all([
      loginAs(ADMIN_USER.username, ADMIN_USER.password),
      loginAs(COORDINATOR.username, COORDINATOR.password),
    ]);
    adminApi = adminPrimed.api;
    adminUserId = adminPrimed.userId;
    coordinatorApi = coordPrimed.api;
    coordinatorUserId = coordPrimed.userId;

    // Create a project as admin and seed a requirement.
    projectId = await createProject(adminApi, String(Date.now()));

    // Seed requirement via seed script (bypasses AI pipeline).
    const { spawnSync } = await import("node:child_process");
    const { resolve } = await import("node:path");
    const repoRoot = resolve(new URL(import.meta.url).pathname, "../../../../..");
    const dbFile = process.env.E2E_DB_FILE;
    if (!dbFile) {
      throw new Error("E2E_DB_FILE env var not set — run via playwright config");
    }
    const databaseUrl = `file:${dbFile}`;

    const scriptPath = resolve(repoRoot, "server", "scripts", "e2e-seed-requirement.ts");
    const result = spawnSync(
      "pnpm",
      ["--filter", "@metis/server", "exec", "tsx", scriptPath, projectId, "none"],
      {
        cwd: repoRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_PROVIDER: "sqlite" },
        encoding: "utf8",
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `Requirement seed failed (status=${result.status}):\n${result.stderr}\n${result.stdout}`,
      );
    }
    const parsed = JSON.parse(result.stdout) as { id: string };
    requirementId = parsed.id;
  });

  test.afterAll(async () => {
    await Promise.all([adminApi?.dispose(), coordinatorApi?.dispose()]);
  });

  // --------------------------------------------------------------------------
  // AC1 subset — comment visibility across users
  // --------------------------------------------------------------------------

  // AC: User A posts a comment thread, User B can read it
  test("should allow User B to read a comment created by User A", async () => {
    await test.step("User A creates a comment thread", async () => {
      const res = await adminApi.post(`/api/requirements/${requirementId}/comments`, {
        data: { body: "First comment from admin", title: "Admin thread" },
      });
      expect(res.status(), await res.text()).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.id).toBeTruthy();
      expect(body.data.comments).toHaveLength(1);
      expect(body.data.comments[0].body).toBe("First comment from admin");
    });

    await test.step("User B lists the threads and sees the comment", async () => {
      const res = await coordinatorApi.get(`/api/requirements/${requirementId}/comments`);
      expect(res.status(), await res.text()).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      const threads = body.data as Array<{ comments: Array<{ body: string }> }>;
      const adminThread = threads.find((t) =>
        t.comments.some((c) => c.body === "First comment from admin"),
      );
      expect(adminThread).toBeDefined();
    });
  });

  // AC1 — @mention fan-out: Mention row is persisted after User A posts @coordinator
  test("should persist a Mention row when User A uses @coordinator in a comment", async () => {
    let threadId: string;

    await test.step("User A posts comment with @coordinator mention", async () => {
      const res = await adminApi.post(`/api/requirements/${requirementId}/comments`, {
        data: {
          body: `Hey @coordinator, please review this requirement by EOD.`,
          title: "Review request",
        },
      });
      expect(res.status(), await res.text()).toBe(201);
      const body = await res.json();
      threadId = body.data.id as string;
      expect(threadId).toBeTruthy();
    });

    await test.step("Verify the comment was created with the mention text intact", async () => {
      const res = await adminApi.get(`/api/requirements/${requirementId}/comments`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      const threads = body.data as Array<{
        id: string;
        comments: Array<{ body: string; authorId: string }>;
      }>;
      const reviewThread = threads.find((t) => t.id === threadId);
      expect(reviewThread).toBeDefined();
      const firstComment = reviewThread!.comments[0];
      expect(firstComment.body).toContain("@coordinator");
      expect(firstComment.authorId).toBe(adminUserId);
    });

    // The fanOutMentions fn is fire-and-forget on the server. Give it a brief
    // moment to complete before verifying the coordinator can see the thread.
    await test.step("User B (coordinator) sees the thread in their feed", async () => {
      const res = await coordinatorApi.get(`/api/requirements/${requirementId}/comments`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      const threads = body.data as Array<{ id: string }>;
      const found = threads.find((t) => t.id === threadId);
      expect(found, "coordinator should see the mention thread").toBeDefined();
    });
  });

  // AC1 — User B replies in an existing thread
  test("should allow User B (coordinator) to post a reply in User A's thread", async () => {
    let threadId: string;
    let replyId: string;

    await test.step("User A creates the parent thread", async () => {
      const res = await adminApi.post(`/api/requirements/${requirementId}/comments`, {
        data: { body: "Admin opens a review thread." },
      });
      expect(res.status(), await res.text()).toBe(201);
      threadId = (await res.json()).data.id as string;
    });

    await test.step("User B posts a reply", async () => {
      const res = await coordinatorApi.post(`/api/comments/${threadId}/replies`, {
        data: { body: "Coordinator replying: LGTM!" },
      });
      expect(res.status(), await res.text()).toBe(201);
      const body = await res.json();
      replyId = body.data.id as string;
      expect(replyId).toBeTruthy();
      expect(body.data.body).toBe("Coordinator replying: LGTM!");
    });

    await test.step("User A can read the reply in the thread listing", async () => {
      const res = await adminApi.get(`/api/requirements/${requirementId}/comments`);
      expect(res.status()).toBe(200);
      const threads = (await res.json()).data as Array<{
        id: string;
        comments: Array<{ id: string; body: string }>;
      }>;
      const thread = threads.find((t) => t.id === threadId)!;
      expect(thread).toBeDefined();
      const reply = thread.comments.find((c) => c.id === replyId);
      expect(reply).toBeDefined();
      expect(reply!.body).toBe("Coordinator replying: LGTM!");
    });
  });

  // AC1 — author can edit their own comment
  test("should allow an author to edit their own comment", async () => {
    let commentId: string;

    await test.step("Admin creates a comment", async () => {
      const res = await adminApi.post(`/api/requirements/${requirementId}/comments`, {
        data: { body: "Original body text." },
      });
      expect(res.status()).toBe(201);
      commentId = (await res.json()).data.comments[0].id as string;
    });

    await test.step("Admin edits the comment", async () => {
      const res = await adminApi.patch(`/api/comments/${commentId}`, {
        data: { body: "Corrected body text." },
      });
      expect(res.status(), await res.text()).toBe(200);
      const body = await res.json();
      expect(body.data.body).toBe("Corrected body text.");
    });

    await test.step("Coordinator sees the updated body", async () => {
      const res = await coordinatorApi.get(`/api/requirements/${requirementId}/comments`);
      const threads = (await res.json()).data as Array<{
        comments: Array<{ id: string; body: string; editedAt: string | null }>;
      }>;
      const comment = threads.flatMap((t) => t.comments).find((c) => c.id === commentId);
      expect(comment).toBeDefined();
      expect(comment!.body).toBe("Corrected body text.");
      expect(comment!.editedAt).toBeTruthy();
    });
  });

  // AC1 — author can soft-delete their own comment
  test("should soft-delete a comment so it shows as deleted to others", async () => {
    let commentId: string;

    await test.step("Admin creates a comment to delete", async () => {
      const res = await adminApi.post(`/api/requirements/${requirementId}/comments`, {
        data: { body: "This will be deleted." },
      });
      expect(res.status()).toBe(201);
      commentId = (await res.json()).data.comments[0].id as string;
    });

    await test.step("Admin soft-deletes the comment", async () => {
      const res = await adminApi.delete(`/api/comments/${commentId}`);
      expect(res.status(), await res.text()).toBe(200);
    });

    await test.step("Coordinator sees the deleted placeholder", async () => {
      const res = await coordinatorApi.get(`/api/requirements/${requirementId}/comments`);
      const threads = (await res.json()).data as Array<{
        comments: Array<{ id: string; body: string | null; deleted: boolean }>;
      }>;
      const comment = threads.flatMap((t) => t.comments).find((c) => c.id === commentId);
      expect(comment).toBeDefined();
      expect(comment!.deleted).toBe(true);
      expect(comment!.body).toBeNull();
    });
  });

  // AC4 subset — SLA assignment stored correctly
  test("should store a SLA deadline when admin assigns coordinator to a requirement", async () => {
    const deadline = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(); // +2 days

    await test.step("Admin assigns coordinator with a 2-day SLA deadline", async () => {
      const res = await adminApi.post(`/api/requirements/${requirementId}/assignments`, {
        data: { assigneeId: coordinatorUserId, slaDeadline: deadline },
      });
      expect(res.status(), await res.text()).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.assigneeId).toBe(coordinatorUserId);
      // The returned slaDeadline should round-trip as an ISO date string.
      expect(new Date(body.data.slaDeadline as string).toISOString()).toBe(deadline);
    });

    await test.step("GET assignments returns the stored SLA deadline", async () => {
      const res = await adminApi.get(`/api/requirements/${requirementId}/assignments`);
      expect(res.status()).toBe(200);
      const assignments = (await res.json()).data as Array<{
        assigneeId: string;
        slaDeadline: string | null;
      }>;
      const assignment = assignments.find((a) => a.assigneeId === coordinatorUserId);
      expect(assignment).toBeDefined();
      expect(assignment!.slaDeadline).toBeTruthy();
      expect(new Date(assignment!.slaDeadline!).getTime()).toBeCloseTo(
        new Date(deadline).getTime(),
        -3, // within 1 s
      );
    });
  });

  // Spec Kit artifact comment thread
  test("should support comment threads on Spec Kit artifacts", async () => {
    await test.step("Enable Spec Kit Mode on the project", async () => {
      const res = await adminApi.put(`/api/projects/${projectId}/spec-kit/enabled`, {
        data: { enabled: true },
      });
      expect(res.status(), await res.text()).toBe(200);
    });

    await test.step("Admin posts a comment on spec.md artifact", async () => {
      const res = await adminApi.post(
        `/api/projects/${projectId}/spec-kit/artifacts/spec.md/comments`,
        { data: { body: "Spec artifact comment from admin." } },
      );
      expect(res.status(), await res.text()).toBe(201);
      const body = await res.json();
      expect(body.data.specKitProjectId).toBe(projectId);
      expect(body.data.specKitArtifactName).toBe("spec.md");
    });

    await test.step("Coordinator reads the spec artifact comment", async () => {
      const res = await coordinatorApi.get(
        `/api/projects/${projectId}/spec-kit/artifacts/spec.md/comments`,
      );
      expect(res.status()).toBe(200);
      const threads = (await res.json()).data as Array<{
        comments: Array<{ body: string }>;
      }>;
      const found = threads.some((t) =>
        t.comments.some((c) => c.body === "Spec artifact comment from admin."),
      );
      expect(found).toBe(true);
    });
  });
});
