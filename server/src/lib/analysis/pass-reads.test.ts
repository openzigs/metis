/**
 * #2448 — a pass's access and read set, without a database: whose access a
 * pass reads with, what its code filter hides and records, and what a result
 * persisted inside or outside a pass records. End to end over a real database
 * and the real orchestrator: `tests/starter-access-2448.sqlite.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { InactiveAclActorError, type AclActor } from "../rag/acl.js";

const resolveSpy = vi.hoisted(() => vi.fn());
vi.mock("../rag/acl.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rag/acl.js")>()),
  resolveAclActor: resolveSpy,
}));
import {
  beginPassReads,
  currentPassReads,
  passCodeAccess,
  readSetForPersist,
  readsWithStarterAccess,
  recordPassReads,
  storedReadSet,
  withPassReads,
  type PassReads,
} from "./pass-reads.js";

const ALICE: AclActor = { userId: "alice", role: "analyst" };
const ids = (documentIds: string[]) => JSON.stringify({ documentIds, chunkIds: [] });
const onlyAlice = JSON.stringify([{ kind: "user", value: "alice" }]);
const onlyBob = JSON.stringify([{ kind: "user", value: "bob" }]);

/** A fake of the three reads a pass makes, counting them. */
function fakeDb(
  run: { projectId: string; sourceAccess: string | null } | null,
  docs: Array<{ id: string; filename: string; source: string; aclSubjects: string }> = [],
  results: Array<{ agentKey: string; readSourceIds: string | null }> = [],
) {
  const db = {
    analysis: { findUnique: vi.fn(async () => run) },
    document: { findMany: vi.fn(async () => docs) },
    agentResult: {
      findMany: vi.fn(async ({ where }: { where: { agentKey?: { not: string } } }) =>
        results.filter((r) => r.agentKey !== where.agentKey?.not),
      ),
    },
  };
  return db as typeof db & Parameters<typeof beginPassReads>[1];
}

const STARTER = { projectId: "p1", sourceAccess: "starter" };
const repoDoc = (id: string, file: string, aclSubjects: string, repo = "r1") => ({
  id,
  filename: `connector:repo:${repo}:src/${file}`,
  source: "repo",
  aclSubjects,
});

describe("beginPassReads (#2448)", () => {
  it("reads as the shared audience when nobody, or the system, runs the pass: no query", async () => {
    const db = fakeDb(STARTER);
    expect(await beginPassReads({ analysisId: "a" }, db)).toBeNull();
    expect(await beginPassReads({ analysisId: "a", actorId: "system" }, db)).toBeNull();
    expect(db.analysis.findUnique).not.toHaveBeenCalled();
  });

  it("reads as the shared audience on a run that is not a starter run", async () => {
    for (const run of [
      null,
      { projectId: "p1", sourceAccess: "shared" },
      { projectId: "p1", sourceAccess: null },
    ]) {
      const db = fakeDb(run);
      expect(await beginPassReads({ analysisId: "a", actorId: "alice" }, db)).toBeNull();
      expect(db.document.findMany).not.toHaveBeenCalled();
    }
  });

  it("reads as the shared audience for a person who cannot be resolved; any other failure rejects", async () => {
    resolveSpy.mockRejectedValueOnce(new InactiveAclActorError());
    expect(await beginPassReads({ analysisId: "a", actorId: "gone" }, fakeDb(STARTER))).toBeNull();
    resolveSpy.mockRejectedValueOnce(new Error("db down"));
    await expect(
      beginPassReads({ analysisId: "a", actorId: "alice" }, fakeDb(STARTER)),
    ).rejects.toThrow("db down");
  });

  it("splits the project's restricted documents into what the person may and may not read", async () => {
    resolveSpy.mockResolvedValueOnce(ALICE);
    const db = fakeDb(STARTER, [
      repoDoc("d-vault", "src/vault.ts", onlyAlice),
      repoDoc("d-vault-2", "src/vault.ts", onlyAlice, "r2"),
      repoDoc("d-hr", "src/hr.ts", onlyBob),
      { id: "d-memo", filename: "memo.md", source: "upload", aclSubjects: onlyAlice },
      // An unreadable list restricts nothing.
      repoDoc("d-garbage", "src/x.ts", "{not json"),
    ]);
    const pass = (await beginPassReads({ analysisId: "a", actorId: "alice" }, db))!;
    expect(pass.actor).toBe(ALICE);
    expect(pass.projectId).toBe("p1");
    expect([...pass.readable].sort()).toEqual(["d-memo", "d-vault", "d-vault-2"]);
    expect(pass.readableFiles.get("r1")?.get("src/vault.ts")).toEqual(["d-vault"]);
    expect(pass.readableFiles.get("r2")?.get("src/vault.ts")).toEqual(["d-vault-2"]);
    expect(pass.hiddenFiles).toEqual([{ connectorId: "r1", path: "src/hr.ts" }]);
    expect([...pass.upstream!]).toEqual([]);
    expect(db.document.findMany).toHaveBeenCalledWith({
      where: { projectId: "p1", deletedAt: null, NOT: { aclSubjects: "[]" } },
      select: { id: true, filename: true, source: true, aclSubjects: true },
    });
  });

  it("starts from what the run's other passes read, and fails closed on one that recorded none", async () => {
    resolveSpy.mockResolvedValue(ALICE);
    const recorded = fakeDb(
      STARTER,
      [],
      [
        { agentKey: "document", readSourceIds: ids(["d-1"]) },
        { agentKey: "database", readSourceIds: ids(["d-2", "d-1"]) },
        // The code pass this one replaces is not its input.
        { agentKey: "code", readSourceIds: null },
      ],
    );
    const pass = await beginPassReads(
      { analysisId: "a", actorId: "alice", agentKey: "code" },
      recorded,
    );
    expect([...pass!.upstream!].sort()).toEqual(["d-1", "d-2"]);
    const unrecorded = fakeDb(STARTER, [], [{ agentKey: "document", readSourceIds: null }]);
    const closed = await beginPassReads(
      { analysisId: "a", actorId: "alice", agentKey: "code" },
      unrecorded,
    );
    expect(closed!.upstream).toBeNull();
    resolveSpy.mockReset();
  });
});

describe("storedReadSet (#2448)", () => {
  it("is the union of every recorded read set, or null when one is missing or unreadable", async () => {
    const db = (readSourceIds: Array<string | null>) =>
      fakeDb(
        null,
        [],
        readSourceIds.map((r) => ({ agentKey: "x", readSourceIds: r })),
      );
    expect([...(await storedReadSet(db([ids(["b"]), ids(["a", "b"])]), "a"))!].sort()).toEqual([
      "a",
      "b",
    ]);
    expect(await storedReadSet(db([ids(["a"]), null]), "a")).toBeNull();
    expect(await storedReadSet(db(["[]"]), "a")).toBeNull();
    expect(await storedReadSet(db([]), "a")).toEqual(new Set());
  });
});

/** A pass of Alice's, built by hand. */
function passOf(over: Partial<PassReads> = {}): PassReads {
  return {
    analysisId: "a",
    projectId: "p1",
    actor: ALICE,
    readable: new Set(["d-vault", "d-memo"]),
    readableFiles: new Map([["r1", new Map([["src/vault.ts", ["d-vault"]]])]]),
    hiddenFiles: [{ connectorId: "r1", path: "src/hr.ts" }],
    upstream: new Set(),
    own: new Set(),
    ...over,
  };
}

describe("passCodeAccess (#2448)", () => {
  it("hides what the person may not see, admits what they may, and records each admitted read", () => {
    const pass = passOf();
    const access = passCodeAccess(pass);
    expect(access.unrestricted).toBe(false);
    expect(access.isHidden("r1", "src/hr.ts")).toBe(true);
    expect(access.isHidden("r1", "src/fee.ts")).toBe(false);
    expect(pass.own.size).toBe(0);
    // Normalised, as the code graph is.
    expect(access.isHidden("r1", "./src/vault.ts")).toBe(false);
    expect([...pass.own]).toEqual(["d-vault"]);
    expect(access.hiddenFileCount).toBe(1);
  });

  it("matches a path in another repository not at all, and one of an unknown repository in every one", () => {
    const pass = passOf();
    const access = passCodeAccess(pass);
    expect(access.isHidden("r2", "src/vault.ts")).toBe(false);
    expect(pass.own.size).toBe(0);
    expect(access.isHidden(null, "src/vault.ts")).toBe(false);
    expect([...pass.own]).toEqual(["d-vault"]);
  });

  it("leaves what it would record out of the bulk exclusion list, which records nothing", () => {
    const pass = passOf();
    const access = passCodeAccess(pass);
    expect(access.hiddenPaths("r1").sort()).toEqual(["src/hr.ts", "src/vault.ts"]);
    expect(access.hiddenPaths("r2")).toEqual([]);
    expect(access.hiddenPaths(null).sort()).toEqual(["src/hr.ts", "src/vault.ts"]);
    expect(pass.own.size).toBe(0);
  });

  it("is the plain hidden-files filter when the person may read no restricted file", () => {
    const hiddenOnly = passCodeAccess(passOf({ readableFiles: new Map() }));
    expect(hiddenOnly.isHidden("r1", "src/hr.ts")).toBe(true);
    expect(hiddenOnly.hiddenPaths("r1")).toEqual(["src/hr.ts"]);
    expect(passCodeAccess(passOf({ readableFiles: new Map(), hiddenFiles: [] })).unrestricted).toBe(
      true,
    );
  });
});

describe("recordPassReads (#2448)", () => {
  it("keeps only the restricted documents the person may read", () => {
    const pass = passOf();
    recordPassReads(pass, ["d-open", "d-memo", "d-hr"]);
    expect([...pass.own]).toEqual(["d-memo"]);
  });
});

describe("withPassReads and readSetForPersist (#2448)", () => {
  it("records inside a pass what earlier passes read and what it read, sorted", async () => {
    resolveSpy.mockResolvedValue(ALICE);
    const db = fakeDb(
      STARTER,
      [repoDoc("d-vault", "src/vault.ts", onlyAlice)],
      [{ agentKey: "document", readSourceIds: ids(["d-memo"]) }],
    );
    const out = await withPassReads(
      { analysisId: "a", actorId: "alice", agentKey: "code" },
      async () => {
        const pass = currentPassReads("a")!;
        expect(currentPassReads("b")).toBeUndefined();
        passCodeAccess(pass).isHidden("r1", "src/vault.ts");
        return readSetForPersist("a", db);
      },
      db,
    );
    expect(out).toEqual(["d-memo", "d-vault"]);
    expect(currentPassReads("a")).toBeUndefined();
    resolveSpy.mockReset();
  });

  it("records nothing it cannot tell: a pass whose upstream is unknown", async () => {
    resolveSpy.mockResolvedValue(ALICE);
    const db = fakeDb(STARTER, [], [{ agentKey: "document", readSourceIds: null }]);
    const out = await withPassReads(
      { analysisId: "a", actorId: "alice", agentKey: "code" },
      () => readSetForPersist("a", db),
      db,
    );
    expect(out).toBeNull();
    resolveSpy.mockReset();
  });

  it("runs the pass as the shared audience when it cannot begin, never unchecked", async () => {
    const db = fakeDb(STARTER);
    db.analysis.findUnique.mockRejectedValueOnce(new Error("db down"));
    const ran = await withPassReads(
      { analysisId: "a", actorId: "alice" },
      async () => currentPassReads("a"),
      db,
    );
    expect(ran).toBeUndefined();
  });

  it("outside a pass: nothing on a run that is not a starter run, else every stored read set, its own included", async () => {
    expect(
      await readSetForPersist("a", fakeDb({ projectId: "p1", sourceAccess: "shared" })),
    ).toBeUndefined();
    // Synthesis again after Bob regenerated Alice's code pass: its earlier
    // result still carries what her pass read, and so does the new one.
    const db = fakeDb(
      STARTER,
      [],
      [
        { agentKey: "code", readSourceIds: ids([]) },
        { agentKey: "synthesis", readSourceIds: ids(["d-vault"]) },
      ],
    );
    expect(await readSetForPersist("a", db)).toEqual(["d-vault"]);
    const unrecorded = fakeDb(STARTER, [], [{ agentKey: "code", readSourceIds: null }]);
    expect(await readSetForPersist("a", unrecorded)).toBeNull();
  });

  it("readsWithStarterAccess reads the run's marker", async () => {
    expect(await readsWithStarterAccess("a", fakeDb(STARTER))).toBe(true);
    expect(
      await readsWithStarterAccess("a", fakeDb({ projectId: "p1", sourceAccess: "shared" })),
    ).toBe(false);
    expect(await readsWithStarterAccess("a", fakeDb(null))).toBe(false);
  });
});
