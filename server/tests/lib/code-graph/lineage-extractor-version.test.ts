/**
 * #935 — `LINEAGE_EXTRACTOR_VERSION` must move whenever the sidecar's
 * extractor source does.
 *
 * The version is part of every stored lineage fingerprint (`on:v<N>:…`), and a
 * changed fingerprint is the ONLY thing that makes an incremental ingest
 * re-extract an unchanged file. PR #873 (#859) fixed
 * `metis-sql-lineage/app/extractor.py` without bumping the version, so the fix
 * never reached a stored graph: the old builtin `executes` edges and the
 * misattributed `UPDATE … FROM` writes survived every re-ingest.
 *
 * This pins a content hash of `metis-sql-lineage/app/**.py` to the version that
 * shipped it. Change any file there and this goes red until you:
 *   1. bump `LINEAGE_EXTRACTOR_VERSION` in `server/src/lib/code-graph/ingest.ts`
 *      (and extend its History comment), and
 *   2. update `PINNED` below to the new version and the hash the failure prints.
 * A change that cannot alter any edge (a log line in `server.py`) still trips
 * it; the cost of bumping anyway is one full lineage re-parse per project.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LINEAGE_EXTRACTOR_VERSION } from "../../../src/lib/code-graph/ingest.js";

const PINNED = {
  version: 3,
  sha256: "c55a5121ce2e589a82a7f17b4a083c99d923eee0d8d3aea0445b549aeb34fdc9",
} as const;

const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../metis-sql-lineage/app",
);

/** Every `.py` file under `dir`, as sorted POSIX paths relative to it. */
function pythonFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name !== "__pycache__") out.push(...pythonFiles(dir, child));
    } else if (entry.isFile() && entry.name.endsWith(".py")) {
      out.push(child);
    }
  }
  return out.sort();
}

/**
 * sha256 over each file's relative path and content. CRLF is normalised to LF
 * so a Windows checkout hashes the same as the committed bytes.
 */
function extractorSourceHash(dir: string): string {
  const h = createHash("sha256");
  for (const rel of pythonFiles(dir)) {
    const text = readFileSync(path.join(dir, rel), "utf8").replace(/\r\n/g, "\n");
    h.update(`${rel}\0${text}\0`);
  }
  return h.digest("hex");
}

describe("#935: LINEAGE_EXTRACTOR_VERSION tracks the sidecar extractor source", () => {
  it("hashes a non-empty extractor tree", () => {
    expect(pythonFiles(APP_DIR)).toContain("extractor.py");
  });

  it("the pinned version is the shipped version", () => {
    expect(
      LINEAGE_EXTRACTOR_VERSION,
      "LINEAGE_EXTRACTOR_VERSION changed: update PINNED in this test to the new version " +
        "and the current metis-sql-lineage/app hash.",
    ).toBe(PINNED.version);
  });

  it("metis-sql-lineage/app is unchanged since the pinned version", () => {
    const actual = extractorSourceHash(APP_DIR);
    expect(
      actual,
      `metis-sql-lineage/app changed (sha256 ${actual}) but PINNED still records ` +
        `v${PINNED.version}. Bump LINEAGE_EXTRACTOR_VERSION in ` +
        "server/src/lib/code-graph/ingest.ts so stored lineage is re-extracted (#935), " +
        "then set PINNED to the new version and this hash.",
    ).toBe(PINNED.sha256);
  });
});
