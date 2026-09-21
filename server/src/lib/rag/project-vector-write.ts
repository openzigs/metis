import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { reindexSwapMaxWaitMs, reindexSwapTimeoutMs } from "./reindex-swap-budget.js";
import type { StoredChunkRef, SwapGuard, VectorRow } from "./vector-store.js";

/** Authoritative migration state, never inferred from speculative vector rows. */
export interface VectorGeneration {
  model: string;
  dimension: number;
  pending: boolean;
}

export interface ProjectVectorWrite {
  /** PostgreSQL operations and SQL selection MUST share this transaction. */
  sql?: Prisma.TransactionClient;
  upsert(projectId: string, rows: VectorRow[]): Promise<unknown>;
  deleteByChunkIds(projectId: string, ids: string[]): Promise<unknown>;
  listChunkRefs(projectId: string): Promise<StoredChunkRef[]>;
  swapTable(projectId: string, shadowId: string, guard?: SwapGuard): Promise<void>;
  readGeneration(): Promise<VectorGeneration | null>;
  writeGeneration(generation: VectorGeneration): Promise<void>;
}

export interface ProjectWriteCapability {
  withProjectWrite?<T>(
    projectId: string,
    fn: (write: ProjectVectorWrite) => Promise<T>,
  ): Promise<T>;
}

export async function withVectorSql<T>(
  write: Pick<ProjectVectorWrite, "sql">,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (write.sql) return fn(write.sql);
  // File stores can still be constructed standalone without initializing SQL.
  const { prisma } = await import("../prisma.js");
  return prisma.$transaction(fn, {
    timeout: reindexSwapTimeoutMs(),
    maxWait: reindexSwapMaxWaitMs(),
  });
}

export function assertVectorGeneration(value: unknown): asserts value is VectorGeneration {
  const generation = value as Partial<VectorGeneration> | null;
  if (
    !generation ||
    typeof generation.model !== "string" ||
    !generation.model ||
    !Number.isInteger(generation.dimension) ||
    (generation.dimension ?? 0) <= 0 ||
    typeof generation.pending !== "boolean"
  )
    throw new Error("Invalid durable vector generation descriptor");
}

export function assertApprovalGeneration(
  generation: VectorGeneration | null,
  rows: VectorRow[],
): void {
  if (generation?.pending)
    throw new Error("Vector migration pending; retry reindex before approval");
  for (const row of rows) {
    if (!row.vector.length || !row.vector.every(Number.isFinite)) {
      throw new Error("Quarantine contains an invalid embedding; re-ingest before approval");
    }
    if (
      row.metadata.embeddingModel !== rows[0].metadata.embeddingModel ||
      row.vector.length !== rows[0].vector.length
    ) {
      throw new Error("Quarantine contains mixed embedding generations; re-ingest before approval");
    }
    if (
      generation &&
      (row.metadata.embeddingModel !== generation.model ||
        row.vector.length !== generation.dimension)
    )
      throw new Error("Quarantine embedding generation is stale; re-ingest before approval");
  }
}

// Separate from each store's short physical-operation mutex: speculative writes
// must remain possible while another approval awaits BM25. Single-process only.
const projectWrites = new Map<string, Promise<void>>();

export async function withFileProjectWrite<T>(
  root: string,
  projectId: string,
  operations: Pick<
    ProjectVectorWrite,
    "upsert" | "deleteByChunkIds" | "listChunkRefs" | "swapTable"
  >,
  fn: (write: ProjectVectorWrite) => Promise<T>,
): Promise<T> {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error("Invalid vector project ID");
  const key = `${path.resolve(root)}\0${projectId}`;
  const previous = projectWrites.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  projectWrites.set(key, next);
  await previous;
  const directory = path.join(root, ".generations");
  const filename = path.join(directory, `${projectId}.json`);
  try {
    return await fn({
      ...operations,
      async readGeneration() {
        let text: string;
        try {
          text = await fs.readFile(filename, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
        const value: unknown = JSON.parse(text);
        assertVectorGeneration(value);
        return value;
      },
      async writeGeneration(generation) {
        assertVectorGeneration(generation);
        await fs.mkdir(directory, { recursive: true });
        const temporary = `${filename}.${randomUUID()}.tmp`;
        try {
          const file = await fs.open(temporary, "wx", 0o600);
          try {
            await file.writeFile(JSON.stringify(generation), "utf8");
            await file.sync();
          } finally {
            await file.close();
          }
          await fs.rename(temporary, filename);
          const dir = await fs.open(directory, "r");
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        } finally {
          await fs.rm(temporary, { force: true });
        }
      },
    });
  } finally {
    release();
    if (projectWrites.get(key) === next) projectWrites.delete(key);
  }
}
