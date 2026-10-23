/**
 * #1171 — the cross-project refusal names the other project only when the
 * caller may open it, and never tells a UI user to pass an API flag.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPayload } from "@metis/shared";

const accessible = new Set<string>();
const names = new Map<string, string>();

vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: {
    // #1180 — the guard's case-insensitive lookup is a tagged `$queryRaw`.
    $queryRaw: vi.fn(async () => []),
    project: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ name: names.get(id) ?? null })),
      ),
    },
  },
}));

vi.mock("../../../src/lib/custom-agents/authz.js", () => ({
  assertLiveProjectAccess: vi.fn(async (_user: AuthPayload, projectId: string) => {
    if (!accessible.has(projectId)) throw new Error("Project not found");
  }),
}));

import { prisma } from "../../../src/lib/prisma.js";
import {
  assertNotCrossProject,
  CrossProjectRepoError,
  crossProjectDryRunNotice,
  crossProjectMessage,
  describeCrossProjectRefusal,
  findCrossProjectOwners,
} from "../../../src/lib/publishing/cross-project-guard.js";

const user = { userId: "u1", role: "developer", workspaces: ["ws_1"] } as unknown as AuthPayload;

beforeEach(() => {
  accessible.clear();
  names.clear();
  names.set("proj_seen", "Flux sandbox");
  names.set("proj_hidden", "Acquisition target X");
  vi.mocked(prisma.project.findMany).mockClear();
});

describe("crossProjectMessage", () => {
  it("says 'another project' when nothing may be named", () => {
    expect(crossProjectMessage("o/r", [])).toBe(
      "o/r is already connected to another project. Confirm to publish to it anyway.",
    );
  });
  it("names one or several projects", () => {
    expect(crossProjectMessage("o/r", ["A"])).toContain('the project "A"');
    expect(crossProjectMessage("o/r", ["A", "B"])).toContain('the projects "A", "B"');
  });
  it("names no API parameter", () => {
    expect(crossProjectMessage("o/r", ["A"])).not.toMatch(/confirmCrossProject|=true|pass /);
  });
});

describe("CrossProjectRepoError", () => {
  it("keeps the conflicting ids off the client-forwarded details", () => {
    const err = new CrossProjectRepoError("o/r", ["proj_hidden"]);
    expect(err.code).toBe("REPO_CROSS_PROJECT");
    expect(err.status).toBe(409);
    expect(JSON.stringify(err.details)).not.toContain("proj_hidden");
    expect(err.message).not.toContain("proj_hidden");
  });
});

describe("describeCrossProjectRefusal", () => {
  it("names a project the caller may open", async () => {
    accessible.add("proj_seen");
    const out = await describeCrossProjectRefusal(
      new CrossProjectRepoError("openzigs/flux-v2", ["proj_seen"]),
      user,
    );
    expect(out.statusCode).toBe(409);
    expect(out.code).toBe("REPO_CROSS_PROJECT");
    expect(out.message).toBe(
      'openzigs/flux-v2 is already connected to the project "Flux sandbox". Confirm to publish to it anyway.',
    );
    expect(out.details).toEqual({ repo: "openzigs/flux-v2", projects: ["Flux sandbox"] });
  });

  it("does not leak the name (or id) of a project the caller cannot open", async () => {
    const out = await describeCrossProjectRefusal(
      new CrossProjectRepoError("openzigs/flux-v2", ["proj_hidden"]),
      user,
    );
    const wire = JSON.stringify({ message: out.message, details: out.details });
    expect(wire).not.toContain("Acquisition target X");
    expect(wire).not.toContain("proj_hidden");
    expect(out.message).toContain("another project");
    expect(out.details).toEqual({ repo: "openzigs/flux-v2", projects: [] });
    // The name is never even read for a project the caller cannot open.
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it("names only the visible ones when several projects conflict", async () => {
    accessible.add("proj_seen");
    const out = await describeCrossProjectRefusal(
      new CrossProjectRepoError("o/r", ["proj_hidden", "proj_seen"]),
      user,
    );
    expect(out.message).toContain('"Flux sandbox"');
    expect(out.message).not.toContain("Acquisition target X");
    expect(prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["proj_seen"] } } }),
    );
  });

  it("fails closed when the name lookup errors", async () => {
    accessible.add("proj_seen");
    vi.mocked(prisma.project.findMany).mockRejectedValueOnce(new Error("db down"));
    const out = await describeCrossProjectRefusal(
      new CrossProjectRepoError("o/r", ["proj_seen"]),
      user,
    );
    expect(out.message).toContain("another project");
    expect(out.details).toEqual({ repo: "o/r", projects: [] });
  });
});

describe("assertNotCrossProject (#1180)", () => {
  const input = { projectId: "proj_me", targetOwner: "o", targetRepo: "r" };

  it("throws CrossProjectRepoError carrying the ids when another project connects the repo", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ projectId: "proj_hidden" }] as never);
    const err = await assertNotCrossProject(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrossProjectRepoError);
    expect((err as CrossProjectRepoError).repo).toBe("o/r");
    expect((err as CrossProjectRepoError).conflictingProjectIds).toEqual(["proj_hidden"]);
  });

  it("passes when no other project connects the repo", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([]);
    await expect(assertNotCrossProject(input)).resolves.toBeUndefined();
  });

  it("a literal true confirms without a lookup; false does not", async () => {
    vi.mocked(prisma.$queryRaw).mockClear();
    await expect(assertNotCrossProject({ ...input, confirmed: true })).resolves.toBeUndefined();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ projectId: "proj_seen" }] as never);
    await expect(assertNotCrossProject({ ...input, confirmed: false })).rejects.toBeInstanceOf(
      CrossProjectRepoError,
    );
  });
});

describe("findCrossProjectOwners", () => {
  it("queries live connectors of OTHER projects for the exact repo", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ projectId: "proj_seen" }] as never);
    const ids = await findCrossProjectOwners({
      projectId: "proj_1",
      targetOwner: "openzigs",
      targetRepo: "flux-v2",
    });
    expect(ids).toEqual(["proj_seen"]);
    // Tagged template: (strings, ...values) — every value is bound, never spliced.
    const [strings, ...values] = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(values).toEqual(["openzigs", "flux-v2", "proj_1"]);
    const sql = strings.join("?").replace(/\s+/g, " ");
    // #1180 — both sides folded, so a case variant of the name still matches.
    expect(sql).toContain('LOWER("ownerOrOrg") = LOWER(?)');
    expect(sql).toContain('LOWER("repoName") = LOWER(?)');
    expect(sql).toContain('"projectId" <> ?');
    expect(sql).toContain('"deletedAt" IS NULL');
  });

  it("returns at most five conflicting projects", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce(
      ["a", "b", "c", "d", "e", "f", "g"].map((projectId) => ({ projectId })) as never,
    );
    const ids = await findCrossProjectOwners({
      projectId: "proj_1",
      targetOwner: "o",
      targetRepo: "r",
    });
    expect(ids).toEqual(["a", "b", "c", "d", "e"]);
  });
});
describe("crossProjectDryRunNotice (#1171)", () => {
  const input = { projectId: "proj_1", targetOwner: "o", targetRepo: "r" };

  it("is null when no other project connects the repo", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([] as never);
    expect(await crossProjectDryRunNotice(input, user)).toBeNull();
  });

  it("names only projects the caller may open", async () => {
    accessible.add("proj_seen");
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { projectId: "proj_hidden" },
      { projectId: "proj_seen" },
    ] as never);
    expect(await crossProjectDryRunNotice(input, user)).toEqual({
      repo: "o/r",
      projects: ["Flux sandbox"],
    });
  });

  it("says nothing it cannot back: a lookup failure yields no notice, not an error", async () => {
    vi.mocked(prisma.$queryRaw).mockRejectedValueOnce(new Error("db down"));
    expect(await crossProjectDryRunNotice(input, user)).toBeNull();
  });
});
