/**
 * GitHub Projects v2 settings service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const projects = new Map<
  string,
  { id: string; githubProjectId: string | null; githubProjectFieldMappings: string | null }
>();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null,
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { githubProjectId: string | null; githubProjectFieldMappings: string | null };
        }) => {
          const p = projects.get(where.id);
          if (!p) throw new Error("not found");
          const next = { ...p, ...data };
          projects.set(where.id, next);
          return next;
        },
      ),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const acquireMock = vi.fn();
vi.mock("../src/lib/publishing/octokit-factory.js", () => ({
  acquirePublishOctokit: (...a: unknown[]) => acquireMock(...a),
  rateLimitConfigFromEnv: () => ({ tokensPerSecond: 1, burst: 1 }),
}));

vi.mock("../src/lib/publishing/host-allowlist.js", () => ({
  resolvePublishTarget: vi.fn(
    async (input: { owner: string; repo: string; baseUrl: string | null }) => ({
      owner: input.owner,
      repo: input.repo,
      baseUrl: input.baseUrl ?? "https://api.github.com",
      pinnedAddress: null,
      pinnedFamily: null,
    }),
  ),
}));

const vaultGet = vi.fn(async () => "tok-123");
vi.mock("../src/lib/connectors/vault-resolver.js", () => ({
  resolveVaultRef: (ref: string) => (ref ? vaultGet() : Promise.resolve(null)),
}));
vi.mock("../src/lib/vault/vault-service.js", () => ({ getVaultService: () => ({}) }));

const listProjectsV2Mock = vi.fn();
vi.mock("../src/lib/publishing/projects-v2.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/publishing/projects-v2.js")>(
    "../src/lib/publishing/projects-v2.js",
  );
  return { ...actual, listProjectsV2: (...a: unknown[]) => listProjectsV2Mock(...a) };
});

import {
  getGitHubProjectV2Settings,
  listGitHubProjectsV2Boards,
  updateGitHubProjectV2Settings,
} from "../src/lib/publishing/github-projects-v2-service.js";
import { PublishError } from "../src/lib/publishing/types.js";

beforeEach(() => {
  projects.clear();
  acquireMock.mockReset();
  listProjectsV2Mock.mockReset();
  vaultGet.mockClear();
});

afterEach(() => vi.clearAllMocks());

describe("getGitHubProjectV2Settings", () => {
  it("404s when project not found", async () => {
    await expect(getGitHubProjectV2Settings("missing")).rejects.toBeInstanceOf(PublishError);
  });
  it("returns parsed mappings", async () => {
    projects.set("p1", {
      id: "p1",
      githubProjectId: "PV_1",
      githubProjectFieldMappings: JSON.stringify({
        Status: { fieldId: "f1", type: "single_select", value: "open" },
      }),
    });
    const r = await getGitHubProjectV2Settings("p1");
    expect(r.githubProjectId).toBe("PV_1");
    expect(r.fieldMappings).toEqual({
      Status: { fieldId: "f1", type: "single_select", value: "open" },
    });
  });
});

describe("updateGitHubProjectV2Settings", () => {
  it("404s when missing", async () => {
    await expect(
      updateGitHubProjectV2Settings("x", { githubProjectId: null, fieldMappings: null }, "u"),
    ).rejects.toBeInstanceOf(PublishError);
  });
  it("persists and returns settings", async () => {
    projects.set("p1", { id: "p1", githubProjectId: null, githubProjectFieldMappings: null });
    const out = await updateGitHubProjectV2Settings(
      "p1",
      {
        githubProjectId: "PV_1",
        fieldMappings: { Status: { fieldId: "f1", type: "single_select", value: "open" } },
      },
      "u1",
    );
    expect(out.githubProjectId).toBe("PV_1");
    expect(out.fieldMappings).toEqual({
      Status: { fieldId: "f1", type: "single_select", value: "open" },
    });
  });
  it("clears mappings when null", async () => {
    projects.set("p1", { id: "p1", githubProjectId: "PV_1", githubProjectFieldMappings: "{}" });
    const out = await updateGitHubProjectV2Settings(
      "p1",
      { githubProjectId: null, fieldMappings: null },
      "u",
    );
    expect(out.githubProjectId).toBeNull();
    expect(out.fieldMappings).toBeNull();
  });
});

describe("listGitHubProjectsV2Boards", () => {
  it("rejects when vault returns no token", async () => {
    await expect(
      listGitHubProjectsV2Boards({ secretRef: "", targetOwner: "o" }),
    ).rejects.toBeInstanceOf(PublishError);
  });
  it("returns boards", async () => {
    acquireMock.mockResolvedValue({});
    listProjectsV2Mock.mockResolvedValue([{ id: "PV_1", number: 1, title: "A", url: "u" }]);
    const out = await listGitHubProjectsV2Boards({ secretRef: "vault://t", targetOwner: "o" });
    expect(out).toHaveLength(1);
    expect(acquireMock).toHaveBeenCalled();
    expect(listProjectsV2Mock).toHaveBeenCalled();
  });
});
