/**
 * Issue #547 — the read-only report of uploads stored before #540 under a
 * reserved (connector- or generated-shaped) filename, run against a REAL SQLite
 * built by the real migration chain so the query means what it does in
 * production against `documents.source` as shipped.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findReservedPrefixUploads,
  formatReservedPrefixUploads,
  type ReservedPrefixUploadsPrisma,
} from "../src/lib/documents/reserved-prefix-uploads.js";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const USER = "u-547";
const PROJ = "proj-547";
const ARCHIVED = "proj-547-archived";

// [id, projectId, filename, source, deletedAt]
const DOCS: Array<[string, string, string, string, number | null]> = [
  // Legacy uploads under every reserved prefix: each is reported.
  ["up-jira", PROJ, "jira:ABC-1", "upload", null],
  ["up-repo", PROJ, "connector:repo:c1:src/a.ts", "upload", null],
  ["up-legacy-repo", PROJ, "repo:c1:src/b.ts", "upload", null],
  ["up-conf", PROJ, "confluence:ENG:42", "upload", null],
  ["up-live", PROJ, "live-schema:x", "upload", null],
  // `generated-doc-` is matched case-insensitively, as `doc-label.ts` reads it.
  ["up-gen", PROJ, "Generated-Doc-abc.md", "upload", null],
  // A control character in a name must not reach the operator's terminal raw.
  ["up-esc", ARCHIVED, "jira:\u001b[31mX\nY", "upload", null],
  // Not reported: the real connector rows, a deleted upload, an ordinary
  // upload, and a pasted title that no reader's pattern matches.
  ["conn-repo", PROJ, "connector:repo:c1:src/a.ts", "repo", null],
  ["conn-jira", PROJ, "jira:ABC-2", "jira", null],
  ["gen", PROJ, "generated-doc-xyz.md", "generated", null],
  ["up-deleted", PROJ, "jira:OLD-1", "upload", 1],
  ["up-plain", PROJ, "notes.md", "upload", null],
  ["up-title", PROJ, "Jira: sprint 12 retro.md", "upload", null],
];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#547 — report of reserved-prefix uploads (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const report = (pageSize?: number) =>
      findReservedPrefixUploads(db as unknown as ReservedPrefixUploadsPrisma, { pageSize });

    beforeAll(() => {
      sqlite = createMigratedSqlite("547-reserved");
      sqlite.exec(
        `INSERT INTO users (id, username, displayName, email, createdAt, updatedAt)
         VALUES (?, ?, 'U', 'u547@example.test', 0, 0)`,
        [USER, USER],
      );
      for (const [id, deletedAt] of [
        [PROJ, null],
        [ARCHIVED, 5],
      ] as const) {
        sqlite.exec(
          `INSERT INTO projects (id, name, slug, createdById, createdAt, updatedAt, deletedAt)
           VALUES (?, ?, ?, ?, 0, 0, ?)`,
          [id, id, id, USER, deletedAt],
        );
      }
      for (const [id, projectId, filename, source, deletedAt] of DOCS) {
        sqlite.exec(
          `INSERT INTO documents (id, projectId, filename, source, mimeType, sizeBytes,
             storagePath, checksum, uploadedById, uploadedAt, deletedAt)
           VALUES (?, ?, ?, ?, 'text/markdown', 1, 'p', ?, ?, 0, ?)`,
          [id, projectId, filename, source, `c-${id}`, USER, deletedAt],
        );
      }
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("names every live upload whose filename carries a reserved prefix, and nothing else", async () => {
      const rows = await report();
      expect(rows.map((r) => [r.documentId, r.reservedPrefix]).sort()).toEqual(
        [
          ["up-conf", "confluence:"],
          ["up-esc", "jira:"],
          ["up-gen", "generated-doc-"],
          ["up-jira", "jira:"],
          ["up-legacy-repo", "repo:"],
          ["up-live", "live-schema:"],
          ["up-repo", "connector:"],
        ].sort(),
      );
      expect(rows.find((r) => r.documentId === "up-jira")).toEqual({
        documentId: "up-jira",
        projectId: PROJ,
        projectArchived: false,
        filename: "jira:ABC-1",
        reservedPrefix: "jira:",
      });
      expect(rows.find((r) => r.documentId === "up-esc")?.projectArchived).toBe(true);
    });

    it("reads every page: a page size smaller than the result loses no row", async () => {
      expect((await report(2)).map((r) => r.documentId).sort()).toEqual(
        (await report()).map((r) => r.documentId).sort(),
      );
    });

    it("formats one line per row with control characters neutralised", async () => {
      const text = formatReservedPrefixUploads(await report());
      const lines = text.split("\n");
      expect(lines[0]).toMatch(/^7 upload\(s\) carry a reserved filename prefix/);
      expect(lines).toHaveLength(1 + 7 + 1);
      expect(text).not.toContain("\u001b");
      expect(text).toContain(`project ${ARCHIVED} (archived): up-esc [jira:] jira:?[31mX?Y`);
      expect(text).toContain(`project ${PROJ}: up-jira [jira:] jira:ABC-1`);
    });

    it("says so when there is nothing to fix", () => {
      expect(formatReservedPrefixUploads([])).toBe("0 upload(s) carry a reserved filename prefix.");
    });
  },
);

describe("formatReservedPrefixUploads — terminal sanitiser (#547)", () => {
  it("neutralises bidi overrides and zero-width characters in a filename", () => {
    const bidiAndZw = [
      "‪",
      "‫",
      "‬",
      "‭",
      "‮",
      "⁦",
      "⁧",
      "⁨",
      "⁩",
      "‎",
      "‏",
      "؜",
      "​",
      "‌",
      "‍",
      "⁠",
      "﻿",
    ];
    const text = formatReservedPrefixUploads([
      {
        documentId: "d1",
        projectId: "p1",
        projectArchived: false,
        filename: `jira:invoice‮fdp.exe${bidiAndZw.join("")}`,
        reservedPrefix: "jira:",
      },
    ]);
    for (const ch of bidiAndZw) expect(text).not.toContain(ch);
    expect(text).toContain(
      `project p1: d1 [jira:] jira:invoice?fdp.exe${"?".repeat(bidiAndZw.length)}`,
    );
  });
});
