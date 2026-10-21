/** #1322 — which repositories the docs-gen source preflight checks, and when it stops. */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { ensureConnectorClone } from "../connectors/repo/clone-health.js";

const graphs = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock("../prisma.js", () => ({
  prisma: { codeGraph: { findMany: vi.fn(async () => graphs.rows) } },
}));

import { prisma } from "../prisma.js";
import {
  ensureRepositorySourcesReady,
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
  ensureClone = vi.fn<typeof ensureConnectorClone>(async () => ({ status: "healthy", path: "/x" }));
});

describe("ensureRepositorySourcesReady", () => {
  it("checks each live git connector at its graph's commit and passes when all are usable", async () => {
    graphs.rows = [graph("g1", conn("c1")), graph("g2", conn("c2", { provider: "gitlab" }))];
    ensureClone.mockResolvedValueOnce({ status: "restored", path: "/c1" });
    const out = await ensureRepositorySourcesReady({ projectId: "p" }, { ensureClone });
    expect(ensureClone).toHaveBeenCalledWith({ projectId: "p", connectorId: "c1", commitSha: SHA });
    expect(ensureClone).toHaveBeenCalledWith({ projectId: "p", connectorId: "c2", commitSha: SHA });
    expect(out.get("g1")).toEqual({ status: "restored", path: "/c1" });
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
    expect(ensureClone).toHaveBeenCalledWith(expect.objectContaining({ commitSha: null }));
  });

  it("throws one error naming every repository that could not be made usable", async () => {
    graphs.rows = [graph("g1", conn("c1")), graph("g2", conn("c2")), graph("g3", conn("c3"))];
    ensureClone
      .mockResolvedValueOnce({ status: "unavailable", reason: "restore-failed", state: "hollow" })
      .mockResolvedValueOnce({ status: "healthy", path: "/c2" })
      .mockResolvedValueOnce({
        status: "unavailable",
        reason: "ingest-in-progress",
        state: "missing",
      });
    const err = await ensureRepositorySourcesReady({ projectId: "p" }, { ensureClone }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SourceCloneUnavailableError);
    expect((err as SourceCloneUnavailableError).code).toBe(SOURCE_CLONE_UNAVAILABLE_CODE);
    expect((err as SourceCloneUnavailableError).repositories).toEqual([
      { repoConnectorId: "c1", codeGraphId: "g1", reason: "restore-failed" },
      { repoConnectorId: "c3", codeGraphId: "g3", reason: "ingest-in-progress" },
    ]);
    expect((err as Error).message).toMatch(/re-ingest/);
  });
});
