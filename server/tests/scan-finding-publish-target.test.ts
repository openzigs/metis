/**
 * #733 — the Scans-page publish route files a scanner finding into the
 * project's saved (or explicitly chosen) GitHub target and NEVER into the
 * scanned repository, which for an analysed project is its upstream.
 *
 *   POST /projects/:projectId/scans/:scanId/findings/:findingId/publish
 *
 * Runs the real route -> publishScanFinding -> publishFinding ->
 * createGitHubIssue chain; only Prisma, the vault and Octokit are mocked, so the
 * assertion is on the URL the GitHub client would actually be asked to POST.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const UPSTREAM = { ownerOrOrg: "miniflux", repoName: "v2" };

const mockPrisma = {
  scanFinding: { findFirst: vi.fn(), findUnique: vi.fn() },
  repoConnection: { findFirst: vi.fn() },
  project: { findUnique: vi.fn() },
  issueLink: { findFirst: vi.fn(), upsert: vi.fn() },
};
vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: unknown, _res: unknown, next: () => void) => {
    (req as { user: { userId: string } }).user = { userId: "user-1" };
    next();
  },
}));
vi.mock("../src/middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/connectors/vault-resolver.js", () => ({
  resolveVaultRef: vi.fn().mockResolvedValue("ghp_fake"),
  readBoundSecret: vi.fn().mockResolvedValue("ghp_fake"),
}));
vi.mock("../src/lib/vault/vault-service.js", () => ({
  getVaultService: vi.fn(() => ({ read: vi.fn() })),
}));
const ghRequest = vi.fn();
const acquirePublishOctokit = vi.fn();
vi.mock("../src/lib/publishing/octokit-factory.js", () => ({
  acquirePublishOctokit: (...args: unknown[]) => acquirePublishOctokit(...args),
}));

const { triageRouter } = await import("../src/routes/triage.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId", triageRouter());
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = err as { statusCode?: number; code?: string; message?: string };
      res
        .status(e.statusCode ?? 500)
        .json({ error: { code: e.code ?? "INTERNAL", message: e.message ?? "?" } });
    },
  );
  return app;
}

const URL_PATH = "/projects/proj-1/scans/scan-1/findings/sf-1/publish";

function saveTarget(owner: string | null, repo: string | null) {
  mockPrisma.project.findUnique.mockResolvedValue({
    publishGithubOwner: owner,
    publishGithubRepo: repo,
  });
}

/** Every repository the GitHub client was asked to file an issue into. */
function filedInto(): string[] {
  return ghRequest.mock.calls.map((c) => (c[0] as { url: string }).url);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.scanFinding.findFirst.mockResolvedValue({
    id: "sf-1",
    triageStatus: "approved",
    materializedFindingId: null,
  });
  mockPrisma.scanFinding.findUnique.mockResolvedValue({
    id: "sf-1",
    fingerprint: "fp-1",
    scanId: "scan-1",
    title: "Null deref",
    body: "details",
    severity: "high",
    category: "security",
    ruleId: null,
    evidenceLines: "[1]",
    scan: { projectId: "proj-1", repoConnectionId: "repo-1", commitSha: "abc123" },
    symbol: { qualifiedName: "a.b", filePath: "a.go" },
  });
  mockPrisma.repoConnection.findFirst.mockResolvedValue({
    id: "repo-1",
    ...UPSTREAM,
    apiBaseUrl: "https://api.github.com",
    secretId: "sec-1",
    lastCommitSha: "abc123",
  });
  mockPrisma.issueLink.findFirst.mockResolvedValue(null);
  mockPrisma.issueLink.upsert.mockImplementation(
    async (args: { create: Record<string, unknown> }) => ({ id: "L1", ...args.create }),
  );
  ghRequest.mockResolvedValue({
    data: { number: 7, html_url: "https://github.com/x/y/issues/7" },
  });
  acquirePublishOctokit.mockResolvedValue({ request: ghRequest });
});

describe("POST /scans/:scanId/findings/:findingId/publish — target (#733)", () => {
  it("refuses with 400 ERR_NO_PUBLISH_TARGET when no target is saved", async () => {
    saveTarget(null, null);
    const res = await request(createApp()).post(URL_PATH).send({ provider: "github" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ERR_NO_PUBLISH_TARGET");
    expect(res.body.error.message).toMatch(/Save as project target/);
    expect(ghRequest).not.toHaveBeenCalled();
    expect(mockPrisma.issueLink.upsert).not.toHaveBeenCalled();
  });

  it("files into the project's saved target", async () => {
    saveTarget("openzigs", "flux-v2");
    const res = await request(createApp()).post(URL_PATH).send({ provider: "github" });
    expect(res.status).toBe(200);
    expect(filedInto()).toEqual(["/repos/openzigs/flux-v2/issues"]);
    expect(mockPrisma.project.findUnique.mock.calls[0][0].where).toEqual({ id: "proj-1" });
  });

  it("files into an explicit body target over the saved one", async () => {
    saveTarget("openzigs", "flux-v2");
    const res = await request(createApp())
      .post(URL_PATH)
      .send({ provider: "github", target: { owner: "octo_shortcode", repo: "sandbox" } });
    expect(res.status).toBe(200);
    expect(filedInto()).toEqual(["/repos/octo_shortcode/sandbox/issues"]);
  });

  it("rejects a malformed body target with 400 before any GitHub call", async () => {
    saveTarget("openzigs", "flux-v2");
    const res = await request(createApp())
      .post(URL_PATH)
      .send({ provider: "github", target: { owner: "-bad", repo: "x" } });
    expect(res.status).toBe(400);
    expect(ghRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["no saved target", null, null],
    ["a half-saved target", "openzigs", null],
    ["a saved target", "openzigs", "flux-v2"],
  ])("never files into the scanned (upstream) repo — %s", async (_label, owner, repo) => {
    saveTarget(owner, repo);
    await request(createApp()).post(URL_PATH).send({ provider: "github" });
    expect(filedInto()).not.toContain(`/repos/${UPSTREAM.ownerOrOrg}/${UPSTREAM.repoName}/issues`);
  });
});
