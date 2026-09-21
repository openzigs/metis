import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertApprovalGeneration,
  assertVectorGeneration,
  withFileProjectWrite,
  withVectorSql,
  type ProjectVectorWrite,
  type VectorGeneration,
} from "./project-vector-write.js";
import type { VectorRow } from "./vector-store.js";

const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("../prisma.js", () => ({ prisma: { $transaction: transaction } }));

const generation: VectorGeneration = { model: "model-v1", dimension: 2, pending: false };

function row(vector = [1, 0], model = generation.model): VectorRow {
  return {
    id: "chunk-1",
    vector,
    metadata: {
      chunkId: "chunk-1",
      documentId: "doc-1",
      filename: "source.md",
      position: 0,
      text: "source",
      embeddingModel: model,
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function operations() {
  return {
    upsert: vi.fn<ProjectVectorWrite["upsert"]>().mockResolvedValue(undefined),
    deleteByChunkIds: vi.fn<ProjectVectorWrite["deleteByChunkIds"]>().mockResolvedValue(1),
    listChunkRefs: vi.fn<ProjectVectorWrite["listChunkRefs"]>().mockResolvedValue([]),
    swapTable: vi.fn<ProjectVectorWrite["swapTable"]>().mockResolvedValue(undefined),
  };
}

const invalidDescriptors: Array<[string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["number", 42],
  ["array", []],
  ["empty object", {}],
  ["missing model", { dimension: 2, pending: false }],
  ["null model", { ...generation, model: null }],
  ["numeric model", { ...generation, model: 1 }],
  ["empty model", { ...generation, model: "" }],
  ["missing dimension", { model: "m", pending: false }],
  ["null dimension", { ...generation, dimension: null }],
  ["string dimension", { ...generation, dimension: "2" }],
  ["fractional dimension", { ...generation, dimension: 1.5 }],
  ["zero dimension", { ...generation, dimension: 0 }],
  ["negative dimension", { ...generation, dimension: -1 }],
  ["NaN dimension", { ...generation, dimension: NaN }],
  ["infinite dimension", { ...generation, dimension: Infinity }],
  ["missing pending", { model: "m", dimension: 2 }],
  ["null pending", { ...generation, pending: null }],
  ["string pending", { ...generation, pending: "false" }],
  ["numeric pending", { ...generation, pending: 0 }],
];

describe("assertVectorGeneration", () => {
  it.each(invalidDescriptors)("rejects %s", (_name, value) => {
    expect(() => assertVectorGeneration(value)).toThrow(
      "Invalid durable vector generation descriptor",
    );
  });

  it.each([false, true])("accepts a valid descriptor with pending=%s", (pending) => {
    expect(() => assertVectorGeneration({ ...generation, pending })).not.toThrow();
  });
});

describe("assertApprovalGeneration", () => {
  it.each([[], [row()]].map((rows) => ({ rows })))(
    "rejects pending migration even for rows $rows",
    ({ rows }) => {
      expect(() => assertApprovalGeneration({ ...generation, pending: true }, rows)).toThrow(
        "Vector migration pending; retry reindex before approval",
      );
    },
  );

  it.each([[], [NaN, 0], [Infinity, 0], [-Infinity, 0]].map((vector) => ({ vector })))(
    "rejects invalid vector $vector",
    ({ vector }) => {
      expect(() => assertApprovalGeneration(null, [row(vector)])).toThrow(
        "Quarantine contains an invalid embedding; re-ingest before approval",
      );
    },
  );

  it("validates every row, not only the first", () => {
    expect(() => assertApprovalGeneration(null, [row(), row([0, NaN])])).toThrow(
      "Quarantine contains an invalid embedding",
    );
  });

  it.each([
    ["model", row([1, 0], "model-v2")],
    ["dimension", row([1, 0, 0])],
  ] as const)("rejects mixed %s without durable metadata", (_name, other) => {
    expect(() => assertApprovalGeneration(null, [row(), other])).toThrow(
      "Quarantine contains mixed embedding generations; re-ingest before approval",
    );
  });

  it.each([
    ["model", { ...generation, model: "model-v2" }],
    ["dimension", { ...generation, dimension: 3 }],
  ] as const)("rejects a stale %s", (_name, durable) => {
    expect(() => assertApprovalGeneration(durable, [row()])).toThrow(
      "Quarantine embedding generation is stale; re-ingest before approval",
    );
  });

  it.each([null, generation])("accepts homogeneous finite rows with generation %j", (durable) => {
    expect(() => assertApprovalGeneration(durable, [row(), row([0, -0.5])])).not.toThrow();
    expect(() => assertApprovalGeneration(durable, [])).not.toThrow();
  });
});

describe("withFileProjectWrite (real generation files)", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "metis-project-write-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(["", "../escape", "/absolute", "a/b", "a\\b", "a\0b", "a b", "a.json"])(
    "rejects unsafe project ID %j before invoking the callback",
    async (projectId) => {
      const callback = vi.fn();
      await expect(withFileProjectWrite(root, projectId, operations(), callback)).rejects.toThrow(
        "Invalid vector project ID",
      );
      expect(callback).not.toHaveBeenCalled();
      expect(await fs.readdir(root)).toEqual([]);
    },
  );

  it("passes through every operation and the callback result without inventing SQL", async () => {
    const ops = operations();
    const result = { published: true };
    const guard = { assertHeld: vi.fn().mockResolvedValue(undefined) };
    await expect(
      withFileProjectWrite(root, "Project_1-ok", ops, async (write) => {
        expect(write.sql).toBeUndefined();
        for (const name of ["upsert", "deleteByChunkIds", "listChunkRefs", "swapTable"] as const) {
          expect(write[name]).toBe(ops[name]);
        }
        await write.upsert("Project_1-ok", [row()]);
        expect(await write.deleteByChunkIds("Project_1-ok", ["chunk-1"])).toBe(1);
        expect(await write.listChunkRefs("Project_1-ok")).toEqual([]);
        await write.swapTable("Project_1-ok", "shadow", guard);
        return result;
      }),
    ).resolves.toBe(result);
    expect(ops.upsert).toHaveBeenCalledWith("Project_1-ok", [row()]);
    expect(ops.deleteByChunkIds).toHaveBeenCalledWith("Project_1-ok", ["chunk-1"]);
    expect(ops.listChunkRefs).toHaveBeenCalledWith("Project_1-ok");
    expect(ops.swapTable).toHaveBeenCalledWith("Project_1-ok", "shadow", guard);
  });

  it("reads absent metadata as null and durably reopens and replaces a generation", async () => {
    await withFileProjectWrite(root, "p1", operations(), async (write) => {
      expect(await write.readGeneration()).toBeNull();
      await write.writeGeneration({ ...generation, pending: true });
    });
    const filename = path.join(root, ".generations", "p1.json");
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).toEqual({
      ...generation,
      pending: true,
    });
    if (process.platform !== "win32") expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
    await withFileProjectWrite(root, "p1", operations(), async (write) => {
      expect(await write.readGeneration()).toEqual({ ...generation, pending: true });
      await write.writeGeneration(generation);
    });
    await expect(
      withFileProjectWrite(root, "p1", operations(), (write) => write.readGeneration()),
    ).resolves.toEqual(generation);
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).toEqual(generation);
    expect(await fs.readdir(path.dirname(filename))).toEqual(["p1.json"]);
  });

  it.each(["{broken", "", '{"model":'])("rejects malformed JSON %j from disk", async (text) => {
    await fs.mkdir(path.join(root, ".generations"));
    await fs.writeFile(path.join(root, ".generations", "p1.json"), text);
    await expect(
      withFileProjectWrite(root, "p1", operations(), (write) => write.readGeneration()),
    ).rejects.toBeInstanceOf(SyntaxError);
  });

  it.each(invalidDescriptors.filter(([, value]) => value !== undefined))(
    "rejects persisted %s descriptor and refuses to overwrite it with invalid metadata",
    async (_name, value) => {
      const directory = path.join(root, ".generations");
      await fs.mkdir(directory);
      const text = JSON.stringify(value);
      const filename = path.join(directory, "p1.json");
      await fs.writeFile(filename, text);
      await expect(
        withFileProjectWrite(root, "p1", operations(), (write) => write.readGeneration()),
      ).rejects.toThrow("Invalid durable vector generation descriptor");
      await expect(
        withFileProjectWrite(root, "p1", operations(), (write) =>
          write.writeGeneration(value as VectorGeneration),
        ),
      ).rejects.toThrow("Invalid durable vector generation descriptor");
      expect(await fs.readFile(filename, "utf8")).toBe(text);
      expect(await fs.readdir(directory)).toEqual(["p1.json"]);
    },
  );

  it("propagates a non-ENOENT read error rather than treating corruption as absence", async () => {
    await fs.writeFile(path.join(root, ".generations"), "not a directory");
    await expect(
      withFileProjectWrite(root, "p1", operations(), (write) => write.readGeneration()),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("propagates directory creation failure without replacing existing data", async () => {
    const filename = path.join(root, ".generations");
    await fs.writeFile(filename, "existing data");
    await expect(
      withFileProjectWrite(root, "p1", operations(), (write) => write.writeGeneration(generation)),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(filename, "utf8")).toBe("existing data");
  });

  it("cleans temporary files after a real rename failure and releases the project for retry", async () => {
    const filename = path.join(root, ".generations", "p1.json");
    await fs.mkdir(filename, { recursive: true });
    await fs.writeFile(path.join(filename, "keep"), "original");
    await expect(
      withFileProjectWrite(root, "p1", operations(), (write) => write.writeGeneration(generation)),
    ).rejects.toMatchObject({ code: expect.any(String) });
    expect(await fs.readFile(path.join(filename, "keep"), "utf8")).toBe("original");
    expect(await fs.readdir(path.dirname(filename))).toEqual(["p1.json"]);
    await fs.rm(filename, { recursive: true });
    await withFileProjectWrite(root, "p1", operations(), (write) =>
      write.writeGeneration(generation),
    );
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).toEqual(generation);
  });

  it.each([false, true])(
    "serializes three same-root writers through success/failure=%s",
    async (fail) => {
      const entered = deferred();
      const release = deferred();
      const secondEntered = deferred();
      const releaseSecond = deferred();
      const events: string[] = [];
      const error = new Error("publication failed");
      const first = withFileProjectWrite(root, "p1", operations(), async () => {
        events.push("first");
        entered.resolve();
        await release.promise;
        if (fail) throw error;
        return "first result";
      });
      // Attach a rejection handler before releasing the failing callback.
      const firstOutcome = first.then(
        (value) => value,
        (reason: unknown) => reason,
      );
      await entered.promise;
      const second = withFileProjectWrite(
        `${root}/../${path.basename(root)}/.`,
        "p1",
        operations(),
        async () => {
          events.push("second");
          secondEntered.resolve();
          await releaseSecond.promise;
          return "second result";
        },
      );
      const third = withFileProjectWrite(root, "p1", operations(), async () => {
        events.push("third");
        return "third result";
      });
      try {
        // An independent callback is an explicit scheduling checkpoint, not a timer.
        await withFileProjectWrite(root, "checkpoint", operations(), async () => undefined);
        expect(events).toEqual(["first"]);
        release.resolve();
        expect(await firstOutcome).toBe(fail ? error : "first result");
        await secondEntered.promise;
        expect(events).toEqual(["first", "second"]);
        releaseSecond.resolve();
        expect(await second).toBe("second result");
        expect(await third).toBe("third result");
        expect(events).toEqual(["first", "second", "third"]);
      } finally {
        release.resolve();
        releaseSecond.resolve();
        await Promise.allSettled([first, second, third]);
      }
    },
  );

  it.each(["different project", "different root"])("does not block a %s", async (kind) => {
    const entered = deferred();
    const release = deferred();
    const first = withFileProjectWrite(root, "p1", operations(), async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try {
      const otherRoot = kind === "different root" ? path.join(root, "other") : root;
      const otherProject = kind === "different project" ? "p2" : "p1";
      await expect(
        withFileProjectWrite(otherRoot, otherProject, operations(), async (write) => {
          await write.writeGeneration(generation);
          return write.readGeneration();
        }),
      ).resolves.toEqual(generation);
      await expect(fs.stat(path.join(root, ".generations", "p1.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      release.resolve();
      await first;
    }
  });
});

describe("withVectorSql", () => {
  beforeEach(() => {
    transaction.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the exact supplied transaction without opening another", async () => {
    const sql = {} as Prisma.TransactionClient;
    const value = { selected: true };
    const callback = vi.fn(async (tx: Prisma.TransactionClient) => {
      expect(tx).toBe(sql);
      return value;
    });
    await expect(withVectorSql({ sql }, callback)).resolves.toBe(value);
    expect(callback).toHaveBeenCalledExactlyOnceWith(sql);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("opens one Prisma transaction with configured budgets when SQL is absent", async () => {
    vi.stubEnv("REINDEX_SWAP_TIMEOUT_MS", "120000");
    vi.stubEnv("REINDEX_SWAP_MAX_WAIT_MS", "45000");
    const sql = {} as Prisma.TransactionClient;
    transaction.mockImplementation(async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(sql),
    );
    const value = { selected: true };
    const callback = vi.fn(async (tx: Prisma.TransactionClient) => {
      expect(tx).toBe(sql);
      return value;
    });
    await expect(withVectorSql({}, callback)).resolves.toBe(value);
    expect(transaction).toHaveBeenCalledExactlyOnceWith(callback, {
      timeout: 120000,
      maxWait: 45000,
    });
    expect(callback).toHaveBeenCalledExactlyOnceWith(sql);
  });

  it.each([true, false])(
    "propagates callback failure without retry with provided SQL=%s",
    async (provided) => {
      const sql = {} as Prisma.TransactionClient;
      const error = new Error("SQL selection failed");
      transaction.mockImplementation(
        async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => fn(sql),
      );
      const callback = vi.fn(async (tx: Prisma.TransactionClient) => {
        expect(tx).toBe(sql);
        throw error;
      });
      await expect(withVectorSql(provided ? { sql } : {}, callback)).rejects.toBe(error);
      expect(callback).toHaveBeenCalledExactlyOnceWith(sql);
      expect(transaction).toHaveBeenCalledTimes(provided ? 0 : 1);
    },
  );

  it("propagates transaction acquisition failure without running the callback", async () => {
    const error = new Error("pool unavailable");
    transaction.mockRejectedValue(error);
    const callback = vi.fn();
    await expect(withVectorSql({}, callback)).rejects.toBe(error);
    expect(callback).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
