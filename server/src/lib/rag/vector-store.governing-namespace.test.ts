/**
 * #1869 — the governing-document namespace of the vector store: its own root on
 * the file stores, a `governing/` key on pgvector, and a name no project table
 * can take.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __clearPgVectorStoreFactory,
  __resetVectorStoreSingleton,
  __setPgVectorStoreFactory,
  getGoverningVectorSpace,
  getVectorStore,
  GOVERNING_VECTOR_NAMESPACE,
  LanceVectorStore,
  LocalVectorStore,
  type VectorStore,
} from "./vector-store.js";

const ENV_KEYS = ["AI_OFFLINE", "VECTOR_STORE", "LANCEDB_PATH"] as const;

describe("governing vector namespace (#1869)", () => {
  let root: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    root = mkdtempSync(path.join(os.tmpdir(), "metis-1869-ns-"));
    process.env.LANCEDB_PATH = root;
    __clearPgVectorStoreFactory();
    __resetVectorStoreSingleton();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __clearPgVectorStoreFactory();
    __resetVectorStoreSingleton();
    rmSync(root, { recursive: true, force: true });
  });

  it("offline: a local store rooted at <root>/governing, one table per workspace", async () => {
    process.env.AI_OFFLINE = "1";
    const space = getGoverningVectorSpace();
    expect(space.store).toBeInstanceOf(LocalVectorStore);
    expect(space.store).not.toBe(getVectorStore());
    expect(space.tableKey("ws1")).toBe("ws1");
    expect(getGoverningVectorSpace()).toBe(space);

    await space.store.upsert(space.tableKey("ws1"), [
      {
        id: "c1",
        vector: [1, 0],
        metadata: {
          documentId: "rev1",
          chunkId: "c1",
          filename: "p.md",
          position: 0,
          text: "governing text",
          embeddingModel: "m",
        },
      },
    ]);
    // A fresh store over the governing root reads it; the project root's store does not.
    const reread = new LocalVectorStore({ root: path.join(root, GOVERNING_VECTOR_NAMESPACE) });
    expect(await reread.count("ws1")).toBe(1);
    expect(await getVectorStore().count("ws1")).toBe(0);
  });

  it("refuses the namespace's name as a project id, so no project table can be it", async () => {
    const store = new LocalVectorStore({ root });
    await expect(store.ensureTable(GOVERNING_VECTOR_NAMESPACE)).rejects.toThrow(/reserved/);
    await expect(store.dropTable(GOVERNING_VECTOR_NAMESPACE)).rejects.toThrow(/reserved/);
    await expect(store.count(GOVERNING_VECTOR_NAMESPACE)).rejects.toThrow(/reserved/);
  });

  it("refuses a workspace id outside the key alphabet", () => {
    process.env.AI_OFFLINE = "1";
    const space = getGoverningVectorSpace();
    for (const bad of ["../ws", "ws/1", "", "a".repeat(129)]) {
      expect(() => space.tableKey(bad)).toThrow(/invalid workspaceId/);
    }
  });

  it("default backend: a LanceDB store of its own under <root>/governing", () => {
    delete process.env.AI_OFFLINE;
    delete process.env.VECTOR_STORE;
    const space = getGoverningVectorSpace();
    expect(space.store).toBeInstanceOf(LanceVectorStore);
    expect((space.store as unknown as { root: string }).root).toBe(
      path.join(root, GOVERNING_VECTOR_NAMESPACE),
    );
    expect(space.tableKey("ws1")).toBe("ws1");
  });

  it("pgvector: the deployment's one store, keyed governing/<workspaceId>", () => {
    delete process.env.AI_OFFLINE;
    process.env.VECTOR_STORE = "pgvector";
    const fake = { kind: "pg" } as unknown as VectorStore;
    __setPgVectorStoreFactory(() => fake);
    const space = getGoverningVectorSpace();
    expect(space.store).toBe(fake);
    expect(space.tableKey("ws1")).toBe(`${GOVERNING_VECTOR_NAMESPACE}/ws1`);
    expect(() => space.tableKey("ws/1")).toThrow(/invalid workspaceId/);
  });
});
