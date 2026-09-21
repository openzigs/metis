/**
 * Epic #396 (MVP-7) — Spec Kit installer orchestrator.
 *
 * Composes the per-feature skeleton, per-host prompts, and `.specify/`
 * scaffold into a single set of writes. Path-traversal validation is
 * applied to every emitted relative path.
 *
 * Modes:
 *   - `skip` (default): existing files are left alone.
 *   - `overwrite`: existing files are clobbered.
 *   - `pr`: writes are bundled into a PR via the existing GitHub bridge
 *     (handed off to caller — this module returns the file set; callers
 *     decide whether to write directly or open a PR).
 *
 * Consent: callers must pass `consent: true`. The route layer enforces
 * this; the orchestrator double-checks (defence in depth).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { audit } from "../../audit/audit-service.js";
import { SpecKitArtifactError } from "../artifacts.js";
import { listFeatures } from "../features.js";
import { resolveAttached } from "./path-guard.js";
import {
  HOSTS,
  emitHostFiles,
  emitCodexAgentsMd,
  isHostKey,
  assertApiBaseUrlAllowed,
  type HostKey,
  type HostEmitContext,
} from "./hosts.js";
import {
  SPECIFY_SKELETON,
  emitFeatureFiles,
  constitutionFile,
  type SkeletonFile,
} from "./skeleton.js";
import { getArtifact } from "../artifacts.js";

export type InstallMode = "skip" | "overwrite" | "pr";

export interface InstallInput {
  projectId: string;
  workspaceRoot: string;
  /** One or more host keys: `"copilot"`, `"claude"`, `"cursor"`, `"pi"`. */
  hosts: HostKey[];
  apiBaseUrl: string;
  mode?: InstallMode;
  /** MUST be `true` to proceed (writing into VCS = consent action). */
  consent: boolean;
  actorId?: string | null;
  /**
   * Optional FS writer override (tests inject a memory writer). Defaults
   * to node:fs/promises with `mode=skip|overwrite` semantics. Callers using
   * `mode=pr` should set `dryRun=true` and read `result.files` themselves.
   */
  dryRun?: boolean;
}

export interface InstallResult {
  files: SkeletonFile[];
  written: number;
  skipped: number;
  hosts: HostKey[];
  featureCount: number;
  mode: InstallMode;
}

/**
 * Issue #432 — file paths whose contents are computed by merging existing
 * disk state (e.g. AGENTS.md). Skip-mode must NOT skip these or the merge
 * collapses into a no-op.
 */
const MERGE_FILES = new Set<string>(["AGENTS.md"]);

export async function planInstall(input: InstallInput): Promise<SkeletonFile[]> {
  if (!input.consent) {
    throw new SpecKitArtifactError(
      400,
      "SPECKIT_CONSENT_REQUIRED",
      "Install requires explicit consent: true (writing into VCS is a consent action).",
    );
  }
  if (!Array.isArray(input.hosts) || input.hosts.length === 0) {
    throw new SpecKitArtifactError(
      400,
      "SPECKIT_HOSTS_REQUIRED",
      "At least one host must be specified.",
    );
  }
  for (const h of input.hosts) {
    if (!isHostKey(h)) {
      throw new SpecKitArtifactError(
        400,
        "SPECKIT_INVALID_HOST",
        `Unknown host: ${h}. Valid: ${HOSTS.join(", ")}`,
      );
    }
  }
  // Bearer-token exfiltration guard — apiBaseUrl is embedded next to
  // `Authorization: Bearer ${METIS_TOKEN}` in every emitted prompt, so the
  // host must be on the configured allowlist.
  assertApiBaseUrlAllowed(input.apiBaseUrl);

  const files: SkeletonFile[] = [...SPECIFY_SKELETON];
  // Constitution → `.specify/memory/constitution.md`.
  const constitution = await getArtifact(input.projectId, "constitution.md");
  if (constitution && constitution.content.trim().length > 0) {
    files.push(constitutionFile(constitution.content));
  }
  // Per-feature artifacts.
  const features = await listFeatures(input.projectId);
  for (const feature of features) {
    const { files: featureFiles } = await emitFeatureFiles(feature);
    files.push(...featureFiles);
  }
  // Per-host prompts.
  const ctx: HostEmitContext = {
    projectId: input.projectId,
    apiBaseUrl: input.apiBaseUrl,
  };
  for (const host of input.hosts) {
    files.push(...emitHostFiles(host, ctx));
  }
  // Issue #432 — Codex also needs an AGENTS.md section listing the
  // `$speckit-*` skill aliases. Read any existing file so we can merge
  // between the marker comments rather than clobbering hand-written prose.
  if (input.hosts.includes("codex")) {
    let existing = "";
    try {
      const abs = await resolveAttached({
        workspaceRoot: input.workspaceRoot,
        target: "AGENTS.md",
      });
      existing = await fs.readFile(abs, "utf8");
    } catch {
      // Missing AGENTS.md — emit fresh.
    }
    files.push(emitCodexAgentsMd(ctx, existing));
  }
  // Path-guard every relative path.
  for (const f of files) {
    await resolveAttached({ workspaceRoot: input.workspaceRoot, target: f.relPath });
  }
  return files;
}

export async function runInstall(input: InstallInput): Promise<InstallResult> {
  const mode: InstallMode = input.mode ?? "skip";
  const files = await planInstall(input);

  let written = 0;
  let skipped = 0;
  if (input.dryRun || mode === "pr") {
    // Caller will handle: PR mode is a future iteration; for v1.3 we
    // surface the file set so the GitHub bridge can open the PR upstream.
    audit({
      actor: input.actorId ? { id: input.actorId } : null,
      action: "speckit.installed",
      target: { type: "project", id: input.projectId },
      metadata: {
        workspaceRoot: input.workspaceRoot,
        host: input.hosts,
        featureCount: (await listFeatures(input.projectId)).length,
        fileCount: files.length,
        mode,
        dryRun: true,
      },
    });
    return {
      files,
      written: 0,
      skipped: 0,
      hosts: input.hosts,
      featureCount: (await listFeatures(input.projectId)).length,
      mode,
    };
  }

  for (const f of files) {
    const abs = await resolveAttached({
      workspaceRoot: input.workspaceRoot,
      target: f.relPath,
    });
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (mode === "skip" && !MERGE_FILES.has(f.relPath)) {
      try {
        await fs.access(abs);
        skipped += 1;
        continue;
      } catch {
        // missing — proceed to write
      }
    }
    await fs.writeFile(abs, f.content, "utf8");
    written += 1;
  }

  const featureCount = (await listFeatures(input.projectId)).length;
  audit({
    actor: input.actorId ? { id: input.actorId } : null,
    action: "speckit.installed",
    target: { type: "project", id: input.projectId },
    metadata: {
      workspaceRoot: input.workspaceRoot,
      host: input.hosts,
      featureCount,
      fileCount: files.length,
      mode,
      written,
      skipped,
    },
  });

  return { files, written, skipped, hosts: input.hosts, featureCount, mode };
}
