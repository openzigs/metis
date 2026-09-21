/**
 * Helpers that shell out to one-shot tsx scripts running against the e2e
 * SQLite database. These exist because the offline-stub AI provider can't
 * produce structured Requirements (see `scripts/seed-requirement.ts`).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.resolve(REPO_ROOT, "server", "scripts", "e2e-seed-requirement.ts");
const DOCUMENT_SCRIPT = path.resolve(REPO_ROOT, "server", "scripts", "e2e-seed-document.ts");
const GROUNDING_SCRIPT = path.resolve(
  REPO_ROOT,
  "server",
  "scripts",
  "e2e-seed-analysis-grounding.ts",
);
const CLARIFY_LOOP_SCRIPT = path.resolve(
  REPO_ROOT,
  "server",
  "scripts",
  "e2e-seed-clarify-loop.ts",
);
const READ_METADATA_SCRIPT = path.resolve(
  REPO_ROOT,
  "server",
  "scripts",
  "e2e-read-analysis-metadata.ts",
);
const COVERAGE_MAPPING_SCRIPT = path.resolve(
  REPO_ROOT,
  "server",
  "scripts",
  "e2e-seed-coverage-mapping.ts",
);
const GENERATED_DOC_SCRIPT = path.resolve(
  REPO_ROOT,
  "server",
  "scripts",
  "e2e-seed-generated-doc.ts",
);

/**
 * Insert a single Requirement row directly into the e2e database. Returns
 * the new requirement id so the spec can target it for draft generation.
 *
 * The script lives under `server/scripts/` so it has natural module
 * resolution for `@prisma/client`. We invoke it with `pnpm exec tsx` from
 * the server workspace.
 */
export function seedRequirementViaCli(opts: {
  projectId: string;
  analysisId: string;
  databaseUrl: string;
}): string {
  const result = spawnSync(
    "pnpm",
    ["--filter", "@metis/server", "exec", "tsx", SCRIPT, opts.projectId, opts.analysisId],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: opts.databaseUrl,
        DATABASE_PROVIDER: "sqlite",
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `e2e-seed-requirement.ts failed (status=${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as { id: string };
  if (!parsed.id) {
    throw new Error(`e2e-seed-requirement.ts returned malformed payload: ${result.stdout}`);
  }
  return parsed.id;
}

/**
 * Insert a single Document row directly into the e2e database with an explicit
 * lifecycle `status`. Returns the new document id.
 *
 * The e2e harness runs ingest synchronously (`INGEST_QUEUE=off`), so a real
 * upload/paste/URL lands in `ready` immediately. To exercise the Analysis
 * page's in-flight status surfacing (issue #906 / #908) a spec needs a document
 * parked in `processing`/`pending` — this helper provides it without driving
 * the ingest pipeline.
 */
export function seedDocumentViaCli(opts: {
  projectId: string;
  uploadedById: string;
  filename: string;
  status: "pending" | "processing" | "ready" | "failed";
  databaseUrl: string;
}): string {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@metis/server",
      "exec",
      "tsx",
      DOCUMENT_SCRIPT,
      opts.projectId,
      opts.uploadedById,
      opts.filename,
      opts.status,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: opts.databaseUrl,
        DATABASE_PROVIDER: "sqlite",
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `e2e-seed-document.ts failed (status=${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as { id: string };
  if (!parsed.id) {
    throw new Error(`e2e-seed-document.ts returned malformed payload: ${result.stdout}`);
  }
  return parsed.id;
}

/**
 * Seed a completed Analysis whose findings exercise the requirement-grounding
 * transparency states added under epic #912 / sub-issue #920:
 *   - a grounded finding (filename-bearing citation + "Grounded in REQ-…"),
 *   - a requirement-gap finding (severity=info + the empty-context note),
 *   - a plain finding with a citation but no requirement linkage.
 *
 * Why this exists: the offline-stub AI provider returns deterministic prose,
 * not the structured JSON the requirement-grounded code agent requires, so a
 * live offline run completes with zero findings and none of the #920 UI states
 * are reachable. The finding shapes are mirrored in
 * `e2e/fixtures/grounding-fixture.ts`; the spec asserts the UI rendering of
 * the seeded snapshot. Returns the new analysis id.
 */
export function seedGroundedAnalysisViaCli(opts: {
  projectId: string;
  startedById: string;
  databaseUrl: string;
}): string {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@metis/server",
      "exec",
      "tsx",
      GROUNDING_SCRIPT,
      opts.projectId,
      opts.startedById,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: opts.databaseUrl,
        DATABASE_PROVIDER: "sqlite",
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `e2e-seed-analysis-grounding.ts failed (status=${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as { id: string };
  if (!parsed.id) {
    throw new Error(`e2e-seed-analysis-grounding.ts returned malformed payload: ${result.stdout}`);
  }
  return parsed.id;
}

/**
 * Epic #209 (#235) — seed a COMPLETED analysis carrying one deterministic
 * specialist finding so the synthesis prompt (and therefore its replay fixture
 * key) is fully predictable. Returns the new analysis id. The finding shape is
 * defined once in `e2e/fixtures/clarify-loop.ts` (`SEED_FINDING`).
 */
export function seedClarifyLoopAnalysisViaCli(opts: {
  projectId: string;
  startedById: string;
  databaseUrl: string;
}): string {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@metis/server",
      "exec",
      "tsx",
      CLARIFY_LOOP_SCRIPT,
      opts.projectId,
      opts.startedById,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: opts.databaseUrl,
        DATABASE_PROVIDER: "sqlite",
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `e2e-seed-clarify-loop.ts failed (status=${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as { id: string };
  if (!parsed.id) {
    throw new Error(`e2e-seed-clarify-loop.ts returned malformed payload: ${result.stdout}`);
  }
  return parsed.id;
}

/**
 * Epic #209 (#235) — read an Analysis row's `metadata` JSON straight from the
 * e2e SQLite DB (bypassing the API) so the spec can assert the refined
 * requirement was *persisted*, not merely returned. Returns the parsed object,
 * or `null` when the row/metadata is absent.
 */
export function readAnalysisMetadataViaCli(opts: {
  analysisId: string;
  databaseUrl: string;
}): Record<string, unknown> | null {
  const result = spawnSync(
    "pnpm",
    ["--filter", "@metis/server", "exec", "tsx", READ_METADATA_SCRIPT, opts.analysisId],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: opts.databaseUrl,
        DATABASE_PROVIDER: "sqlite",
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `e2e-read-analysis-metadata.ts failed (status=${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
  }
  const out = result.stdout.trim();
  if (!out || out === "null") return null;
  return JSON.parse(out) as Record<string, unknown>;
}

/**
 * Epic #260 (#44/#45) — seed a COMPLETED test-coverage run straight into the
 * e2e DB, with one Requirement plus:
 *   - one CoverageMapping per `docTitles[]` entry (target for the JUnit
 *     round-trip verdict propagation, #45), and/or
 *   - one high-confidence Suggestion per `suggestionTitles[]` entry (the
 *     scaffold source for the Playwright-POM export, #44).
 *
 * The offline-stub AI can't deterministically produce mappings/suggestions, so
 * the export-scaffold and matched/updated/unmatched assertions seed them here.
 * Returns the new run id (target for upload/export) plus the requirement id and
 * the created doc titles + suggestion ids.
 */
export function seedCoverageMappingViaCli(opts: {
  projectId: string;
  userId: string;
  docTitles?: string[];
  suggestionTitles?: string[];
  databaseUrl: string;
}): { runId: string; requirementId: string; docTitles: string[]; suggestionIds: string[] } {
  const config = JSON.stringify({
    docTitles: opts.docTitles ?? [],
    suggestionTitles: opts.suggestionTitles ?? [],
  });
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@metis/server",
      "exec",
      "tsx",
      COVERAGE_MAPPING_SCRIPT,
      opts.projectId,
      opts.userId,
      config,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: opts.databaseUrl,
        DATABASE_PROVIDER: "sqlite",
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `e2e-seed-coverage-mapping.ts failed (status=${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as {
    runId: string;
    requirementId: string;
    docTitles: string[];
    suggestionIds: string[];
  };
  if (!parsed.runId) {
    throw new Error(`e2e-seed-coverage-mapping.ts returned malformed payload: ${result.stdout}`);
  }
  return parsed;
}

/**
 * Seed a generated document and its synthetic indexing row directly into the
 * e2e SQLite DB so specs can assert deterministic lifecycle labels.
 */
export function seedGeneratedDocViaCli(opts: {
  projectId: string;
  uploadedById: string;
  title: string;
  generationStatus: "pending" | "generating" | "ready" | "degraded" | "failed";
  indexState: "pending" | "quarantined" | "indexed" | "rejected";
  databaseUrl: string;
  errorMessage?: string;
  warningJson?: string;
  content?: string;
}): { id: string; title: string; generationStatus: string; indexState: string } {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@metis/server",
      "exec",
      "tsx",
      GENERATED_DOC_SCRIPT,
      opts.projectId,
      opts.uploadedById,
      opts.title,
      opts.generationStatus,
      opts.indexState,
      opts.errorMessage ?? "-",
      opts.warningJson ?? "-",
      opts.content ?? "-",
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: opts.databaseUrl,
        DATABASE_PROVIDER: "sqlite",
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `e2e-seed-generated-doc.ts failed (status=${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as {
    id: string;
    title: string;
    generationStatus: string;
    indexState: string;
  };
  if (!parsed.id) {
    throw new Error(`e2e-seed-generated-doc.ts returned malformed payload: ${result.stdout}`);
  }
  return parsed;
}
