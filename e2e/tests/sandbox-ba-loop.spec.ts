/**
 * Sandbox BA-loop e2e — Epic #395 #420.
 *
 * Exercises the BA-loop "fail then fix" round-trip against the real
 * configured sandbox provider:
 *
 *   1. Login with the seeded admin and provision a fresh project.
 *   2. POST `/api/sandbox/run-once` with intentionally failing Python
 *      (`sys.exit(2)`). Assert the response surfaces a non-zero exit
 *      code and a `sessionId`. The provider is responsible for
 *      persisting the matching `SandboxSession` row.
 *   3. POST `/api/sandbox/run-once` a second time with corrected code
 *      (`print("ok")`). Assert the second session's `exitCode === 0`.
 *
 * Gated on `E2B_API_KEY` so the suite is a no-op in the standard
 * mock-mode CI runner. Designed for the dedicated
 * `e2e-sandbox-e2b` workflow that runs only on `push: main` /
 * `workflow_dispatch`.
 *
 * Caps: 60-second sandbox lifetime + 90-second test timeout to keep
 * accidental runaway costs bounded.
 */
import { test, expect, request } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();
const HAS_E2B_KEY = Boolean(process.env.E2B_API_KEY);

test.describe("Sandbox BA-loop (E2B)", () => {
  test.skip(!HAS_E2B_KEY, "E2B_API_KEY not set — skipping live sandbox e2e");
  test.setTimeout(90_000);

  test("fail-then-fix BA loop persists distinct SandboxSession rows with the expected exit codes", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });

    // 1. Login.
    const login = await ctx.post("/api/auth/login", {
      data: { username: "admin", password: "password" },
    });
    expect(login.status(), `login failed: ${login.status()}`).toBe(200);
    const { token } = await login.json();
    const auth = { Authorization: `Bearer ${token}` };

    // 2. Create project.
    const slug = `sandbox-e2e-${Date.now()}`;
    const projectRes = await ctx.post("/api/projects", {
      headers: auth,
      data: { name: `Sandbox E2E ${slug}`, slug },
    });
    expect(projectRes.status()).toBe(201);
    const project = (await projectRes.json()).data;

    // 3a. Failing iteration — assert non-zero exit + session id.
    const failRes = await ctx.post("/api/sandbox/run-once", {
      headers: auth,
      data: {
        projectId: project.id,
        timeoutMs: 60_000,
        language: "python",
        code: "import sys\nsys.exit(2)\n",
      },
    });
    expect(
      failRes.status(),
      `run-once (fail) failed: ${failRes.status()} ${await failRes.text()}`,
    ).toBe(200);
    const failBody = (await failRes.json()).data;
    expect(typeof failBody.sessionId).toBe("string");
    expect(failBody.sessionId.length).toBeGreaterThan(0);
    expect(failBody.exitCode).not.toBe(0);
    expect(typeof failBody.wallClockMs).toBe("number");
    expect(failBody.wallClockMs).toBeGreaterThanOrEqual(0);

    // 3b. Corrected iteration — assert exit code 0 + a *new* session id.
    const passRes = await ctx.post("/api/sandbox/run-once", {
      headers: auth,
      data: {
        projectId: project.id,
        timeoutMs: 60_000,
        language: "python",
        code: 'print("ok")\n',
      },
    });
    expect(
      passRes.status(),
      `run-once (pass) failed: ${passRes.status()} ${await passRes.text()}`,
    ).toBe(200);
    const passBody = (await passRes.json()).data;
    expect(typeof passBody.sessionId).toBe("string");
    expect(passBody.sessionId).not.toBe(failBody.sessionId);
    expect(passBody.exitCode).toBe(0);

    await ctx.dispose();
  });
});
