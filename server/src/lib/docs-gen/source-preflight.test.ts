/** #1322 — which repositories the docs-gen source preflight checks, and when it stops. */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { ensureConnectorClone } from "../connectors/repo/clone-health.js";

const graphs = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  fresh: null as string | null,
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: {
      findMany: vi.fn(async () => graphs.rows),
      findFirst: vi.fn(async () => ({ commitSha: graphs.fresh })),
    },
  },
}));

import { prisma } from "../prisma.js";
import {
  ensureRepositorySourcesReady,
  SOURCE_CLONE_BUSY_CODE,
  SOURCE_CLONE_UNAVAILABLE_CODE,
  SourceCloneUnavailableError,
} from "./source-preflight.js";

const SHA = "c".repeat(40);
const graph = (id: string, connector: Record<string, unknown> | null, commitSha = SHA) => ({
  id,
  commitSha,
  repoConnection: connector,
});
const conn = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: "p",
  deletedAt: null,
  provider: "github",
  ...extra,
});

let ensureClone: Mock<typeof ensureConnectorClone>;
beforeEach(() => {
  vi.clearAllMocks();
  graphs.fresh = null;
  ensureClone = vi.fn<typeof ensureConnectorClone>(async () => ({
    status: "healthy",
    path: "/x",
  }));
});

const unavailable = (reason: "busy" | "restore-failed" | "no-recorded-commit") =>
  ({ status: "unavailable", reason, state: "hollow" }) as const;

describe("ensureRepositorySourcesReady", () => {
  it("checks each live git connector and passes when all are usable", async () => {
    graphs.rows = [graph("g1", conn("c1")), graph("g2", conn("c2", { provider: "gitlab" }))];
    ensureClone.mockResolvedValueOnce({ status: "restored", path: "/c1" });
    const out = await ensureRepositorySourcesReady({ projectId: "p" }, { ensureClone });
    expect(ensureClone.mock.calls.map(([i]) => i.connectorId)).toEqual(["c1", "c2"]);
    expect(out.get("g1")).toEqual({ status: "restored", path: "/c1" });
  });

  it("gives the graph's commit first, and re-reads the graph on later asks", async () => {
    graphs.rows = [graph("g1", conn("c1"))];
    graphs.fresh = "e".repeat(40);
    await ensureRepositorySourcesReady({ projectId: "p" }, { ensureClone });
    const { loadCommitSha } = ensureClone.mock.calls[0]![0];
    expect(await loadCommitSha()).toBe(SHA);
    expect(prisma.codeGraph.findFirst).not.toHaveBeenCalled();
    expect(await loadCommitSha()).toBe("e".repeat(40));
    expect(prisma.codeGraph.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "g1", projectId: "p" } }),
    );
  });

  it("narrows to the document's graph when it has one", async () => {
    graphs.rows = [graph("g1", conn("c1"))];
    await ensureRepositorySourcesReady({ projectId: "p", codeGraphId: "g1" }, { ensureClone });
    expect(prisma.codeGraph.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "p", id: "g1" } }),
    );
  });

  it("skips local/upload connectors, deleted or foreign connectors, and unlinked graphs", async () => {
    graphs.rows = [
      graph("g1", conn("c1", { provider: "local" })),
      graph("g2", conn("c2", { provider: "upload" })),
      graph("g3", conn("c3", { deletedAt: new Date() })),
      graph("g4", conn("c4", { projectId: "other" })),
      graph("g5", null),
    ];
    const out = await ensureRepositorySourcesReady({ projectId: "p" }, { ensureClone });
    expect(ensureClone).not.toHaveBeenCalled();
    expect(out.size).toBe(0);
  });

  it("passes a null commit through rather than guessing one", async () => {
    graphs.rows = [graph("g1", conn("c1"), null as unknown as string)];
    await ensureRepositorySourcesReady({ projectId: "p" }, { ensureClone });
    expect(await ensureClone.mock.calls[0]![0].loadCommitSha()).toBeNull();
  });

  it("throws one re-ingest error naming every repository that could not be made usable", async () => {
    graphs.rows = [graph("g1", conn("c1")), graph("g2", conn("c2")), graph("g3", conn("c3"))];
    ensureClone
      .mockResolvedValueOnce(unavailable("restore-failed"))
      .mockResolvedValueOnce({ status: "healthy", path: "/c2" })
      .mockResolvedValueOnce(unavailable("busy"));
    const err = await ensureRepositorySourcesReady({ projectId: "p" }, { ensureClone }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SourceCloneUnavailableError);
    expect((err as SourceCloneUnavailableError).code).toBe(SOURCE_CLONE_UNAVAILABLE_CODE);
    expect((err as SourceCloneUnavailableError).repositories).toEqual([
      { repoConnectorId: "c1", codeGraphId: "g1", reason: "restore-failed" },
      { repoConnectorId: "c3", codeGraphId: "g3", reason: "busy" },
    ]);
    expect((err as Error).message).toMatch(/re-ingest/);
  });

  it("says busy, never re-ingest, when another job holding a connector is the only obstacle", async () => {
    graphs.rows = [graph("g1", conn("c1"))];
    ensureClone.mockResolvedValueOnce(unavailable("busy"));
    const err = (await ensureRepositorySourcesReady({ projectId: "p" }, { ensureClone }).catch(
      (e: unknown) => e,
    )) as SourceCloneUnavailableError;
    expect(err.code).toBe(SOURCE_CLONE_BUSY_CODE);
    expect(err.message).not.toMatch(/re-ingest/);
  });
});
