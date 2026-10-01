/**
 * Seed many `ready` upload Document rows into the e2e SQLite database in one
 * process (#584).
 *
 * Why this exists: the Workbench Documents panel is virtualised (#526), and
 * proving that in a real browser needs a project with thousands of documents.
 * Uploading them through the API would queue thousands of ingests; spawning
 * `e2e-seed-document.ts` once per row would start thousands of processes. This
 * writes the rows directly, in batches, and nothing ever reads their storage.
 *
 * Invoked from `e2e/tests/workbench-virtualisation.spec.ts` via
 * `seedDocumentsBulkViaCli` in `e2e/fixtures/seed-helpers.ts`.
 *
 * Usage:
 *   tsx server/scripts/e2e-seed-documents-bulk.ts <projectId> <uploadedById> <count>
 *
 * Prints `{ "count": <rows created> }`. Filenames are `bulk-doc-00001.md` …,
 * zero-padded so they sort in creation order.
 */
/* eslint-disable no-console -- this is a CLI script that writes to stdout/stderr */
import { randomBytes } from "node:crypto";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";

const BATCH = 500;
const MAX_COUNT = 20_000;

async function main(): Promise<void> {
  const [projectId, uploadedById, rawCount] = process.argv.slice(2);
  const count = Number(rawCount);
  if (!projectId || !uploadedById || !Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    console.error(
      `usage: e2e-seed-documents-bulk.ts <projectId> <uploadedById> <count 1..${MAX_COUNT}>`,
    );
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL must be set");
    process.exit(2);
  }

  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  const prisma = new PrismaClient({ adapter });
  const width = String(count).length;
  let created = 0;
  try {
    for (let start = 0; start < count; start += BATCH) {
      const end = Math.min(count, start + BATCH);
      const data = [];
      for (let i = start; i < end; i++) {
        data.push({
          projectId,
          filename: `bulk-doc-${String(i + 1).padStart(width, "0")}.md`,
          mimeType: "text/markdown",
          sizeBytes: 128,
          // Synthetic storage path + checksum: these rows never feed an ingest,
          // they only need to be listed by the documents endpoint.
          storagePath: `e2e/seed/${randomBytes(8).toString("hex")}.md`,
          checksum: randomBytes(16).toString("hex"),
          status: "ready",
          uploadedById,
        });
      }
      const res = await prisma.document.createMany({ data });
      created += res.count;
    }
    process.stdout.write(JSON.stringify({ count: created }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
