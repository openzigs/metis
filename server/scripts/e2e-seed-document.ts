/**
 * Seed a single Document row directly into the e2e SQLite database.
 *
 * Why this exists: the e2e harness boots with `INGEST_QUEUE=off`, so every
 * real ingest path (multipart upload, paste-text, URL) runs synchronously and
 * the document lands in `ready` status before the test can observe an
 * in-flight state. To deterministically exercise the Analysis page's ingest
 * status surfacing (issue #906 / #908) we inject a document already parked in
 * `processing` (or any requested status) here, bypassing the ingest pipeline.
 *
 * Invoked from the analysis e2e specs via the helper in
 * `fixtures/seed-helpers.ts`. Reads PrismaClient from the server package so it
 * matches the runtime schema exactly.
 *
 * Usage:
 *   tsx server/scripts/e2e-seed-document.ts <projectId> <uploadedById> <filename> <status>
 */
/* eslint-disable no-console -- this is a CLI script that writes to stdout/stderr */
import { randomBytes } from "node:crypto";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";

async function main(): Promise<void> {
  const [projectId, uploadedById, filename, status] = process.argv.slice(2);
  if (!projectId || !uploadedById || !filename || !status) {
    console.error("usage: e2e-seed-document.ts <projectId> <uploadedById> <filename> <status>");
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL must be set");
    process.exit(2);
  }

  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  const prisma = new PrismaClient({ adapter });
  try {
    const created = await prisma.document.create({
      data: {
        projectId,
        filename,
        mimeType: "text/markdown",
        sizeBytes: 128,
        // Synthetic storage path + checksum — this row never feeds a real
        // ingest, it only needs to render in the Analysis document list with
        // the requested lifecycle status.
        storagePath: `e2e/seed/${randomBytes(8).toString("hex")}.md`,
        checksum: randomBytes(16).toString("hex"),
        status,
        uploadedById,
      },
    });
    process.stdout.write(JSON.stringify({ id: created.id }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
