/**
 * #935 — `LINEAGE_EXTRACTOR_VERSION` must move whenever the sidecar's
 * extraction inputs do.
 *
 * The version is part of every stored lineage fingerprint (`on:v<N>:…`), and a
 * changed fingerprint is the ONLY thing that makes an incremental ingest
 * re-extract an unchanged file. PR #873 (#859) fixed
 * `metis-sql-lineage/app/extractor.py` without bumping the version, so the fix
 * never reached a stored graph: the old builtin `executes` edges and the
 * misattributed `UPDATE … FROM` writes survived every re-ingest.
 *
 * This pins a content hash of the sidecar's extraction inputs — every
 * `metis-sql-lineage/app/**.py` file plus the runtime `requirements.txt` (the
 * `sqlglot` pin decides the parse, and Dependabot has no pip ecosystem, so
 * nothing else would notice a sqlglot upgrade) — to the version that shipped
 * them. Change any of those and this goes red until you:
 *   1. bump `LINEAGE_EXTRACTOR_VERSION` in `server/src/lib/code-graph/ingest.ts`
 *      (and extend its History comment), and
 *   2. add the new version and the hash the failure prints to `HISTORY` below.
 * A change that cannot alter any edge (a log line in `server.py`, a fastapi
 * bump) still trips it; the cost of bumping anyway is one full lineage re-parse
 * per project.
 *
 * NOT guarded here: the server-side TS extractors (embedded-sql, gorm,
 * sqlalchemy, sql-lineage-resolver, plsql-package-lineage) also need a bump
 * when they change the edges an unchanged file produces — see the doc comment
 * on `LINEAGE_EXTRACTOR_VERSION`.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LINEAGE_EXTRACTOR_VERSION } from "../../../src/lib/code-graph/ingest.js";

/**
 * `LINEAGE_EXTRACTOR_VERSION` -> sha256 of the inputs that version shipped
 * with. Only the highest entry is checked; older ones are the audit trail.
 * v3's hash covers `requirements.txt` too: the input set widened in #935's
 * review without changing what v3 extracts.
 */
const HISTORY: Readonly<Record<number, string>> = {
  3: "227073b790b1d2a98529e6988d32929449b9b8656de6b254bec9eec28099be28",
};

const SIDECAR_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../metis-sql-lineage",
);
const APP_DIR = path.join(SIDECAR_DIR, "app");
const REQUIREMENTS = path.join(SIDECAR_DIR, "requirements.txt");

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

/** LF line endings, no trailing whitespace — so a Windows checkout or an
 *  editor's whitespace pass hashes the same as the committed bytes. */
function normaliseRequirements(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
}

/**
 * sha256 over each `app/` file's relative path and content (CRLF normalised to
 * LF), then the normalised runtime requirements.
 */
function extractorInputHash(
  app: ReadonlyArray<readonly [string, string]>,
  requirements: string,
): string {
  const h = createHash("sha256");
  for (const [rel, text] of app) {
    h.update(`app/${rel}\0${text.replace(/\r\n/g, "\n")}\0`);
  }
  h.update(`requirements.txt\0${normaliseRequirements(requirements)}\0`);
  return h.digest("hex");
}

function readAppSources(): Array<[string, string]> {
  return pythonFiles(APP_DIR).map((rel) => [rel, readFileSync(path.join(APP_DIR, rel), "utf8")]);
}

const currentVersion = Math.max(...Object.keys(HISTORY).map(Number));

describe("#935: LINEAGE_EXTRACTOR_VERSION tracks the sidecar extraction inputs", () => {
  it("hashes a non-empty extractor tree and a requirements file that pins sqlglot", () => {
    expect(pythonFiles(APP_DIR)).toContain("extractor.py");
    expect(readFileSync(REQUIREMENTS, "utf8")).toMatch(/^sqlglot==\S+$/m);
  });

  it("the highest HISTORY entry is the shipped version", () => {
    expect(
      LINEAGE_EXTRACTOR_VERSION,
      "LINEAGE_EXTRACTOR_VERSION changed: add the new version and the current " +
        "metis-sql-lineage hash to HISTORY in this test.",
    ).toBe(currentVersion);
  });

  it("metis-sql-lineage/app and requirements.txt are unchanged since that version", () => {
    const actual = extractorInputHash(readAppSources(), readFileSync(REQUIREMENTS, "utf8"));
    expect(
      actual,
      `metis-sql-lineage/app or requirements.txt changed (sha256 ${actual}) but HISTORY ` +
        `still ends at v${currentVersion}. Bump LINEAGE_EXTRACTOR_VERSION in ` +
        "server/src/lib/code-graph/ingest.ts so stored lineage is re-extracted (#935), " +
        "then add the new version and this hash to HISTORY.",
    ).toBe(HISTORY[currentVersion]);
  });

  it("goes red when the sqlglot pin changes (mutation, e.g. 30.11.0 -> 31.0.0)", () => {
    const app = readAppSources();
    const reqs = readFileSync(REQUIREMENTS, "utf8");
    // Always a different pin from the committed one, whatever that becomes.
    const bumped = reqs.replace(
      /^sqlglot==(\S+)$/m,
      (_m, v: string) => `sqlglot==${v === "31.0.0" ? "30.11.0" : "31.0.0"}`,
    );
    expect(bumped).not.toBe(reqs);
    expect(extractorInputHash(app, bumped)).not.toBe(HISTORY[currentVersion]);
  });

  it("ignores CRLF line endings and trailing whitespace in requirements.txt", () => {
    const app = readAppSources();
    const reqs = readFileSync(REQUIREMENTS, "utf8");
    const noisy = reqs.replace(/\n/g, " \t\r\n");
    expect(noisy).not.toBe(reqs);
    expect(extractorInputHash(app, noisy)).toBe(extractorInputHash(app, reqs));
  });
});
