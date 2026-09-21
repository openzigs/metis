/**
 * Noop sandbox provider (Epic #395 #409).
 *
 * Default for `SANDBOX_PROVIDER=noop` (or unset). Creates a tmp directory,
 * inserts a `SandboxSession` row, and returns a `NoopSandbox` that talks
 * to the local filesystem + `child_process.spawn`.
 *
 * Same hard caps as the real adapters; no real isolation. Only safe for
 * trusted callers (offline dev, CI smoke tests).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";

import type { SandboxAuditEmitter } from "../audit/audit-emitter.js";
import { getSandboxAuditEmitter } from "../audit/audit-emitter.js";
import { clampSandboxOptions } from "../clamp.js";
import { buildEffectiveEgressAllowlist, validateEgressAllowlist } from "../egress-defaults.js";
import { getSandboxSessionRepo } from "../repos/sandbox-session.repo.js";
import type { SandboxSessionRepo } from "../repos/sandbox-session.repo.js";
import type { Sandbox, SandboxOptions, SandboxProvider, SandboxProviderKind } from "../types.js";
import { NoopSandbox } from "./noop-sandbox.js";

export interface NoopProviderDeps {
  emitter?: SandboxAuditEmitter;
  sessionRepo?: SandboxSessionRepo;
  /** Test seam — override tmp-dir creation. */
  mkRootDir?: (id: string) => Promise<string>;
}

async function defaultMkRootDir(id: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `metis-noop-sandbox-${id}-`));
}

export class NoopSandboxProvider implements SandboxProvider {
  readonly kind: SandboxProviderKind = "noop";
  private readonly emitter: SandboxAuditEmitter;
  private readonly sessionRepo: SandboxSessionRepo;
  private readonly mkRootDir: (id: string) => Promise<string>;

  constructor(deps: NoopProviderDeps = {}) {
    this.emitter = deps.emitter ?? getSandboxAuditEmitter();
    this.sessionRepo = deps.sessionRepo ?? getSandboxSessionRepo();
    this.mkRootDir = deps.mkRootDir ?? defaultMkRootDir;
  }

  async create(opts: SandboxOptions): Promise<Sandbox> {
    const clamped = clampSandboxOptions(opts, opts.projectConfig);
    // Validate egress now so misconfiguration fails fast even on the noop
    // provider (gives offline-dev a representative error path).
    validateEgressAllowlist(clamped.egressAllowlist);
    const effectiveEgress = buildEffectiveEgressAllowlist(clamped.egressAllowlist);

    const vendorSandboxId = `noop-${ulid()}`;
    const session = await this.sessionRepo.start({
      projectId: clamped.projectId,
      userId: clamped.userId,
      runId: clamped.runId,
      provider: "noop",
      vendorSandboxId,
      templateId: clamped.templateId ?? null,
      vCpus: clamped.vCpus,
      memMiB: clamped.memMiB,
    });

    const rootDir = await this.mkRootDir(session.id);
    const sandbox = new NoopSandbox({
      sessionId: session.id,
      vendorSandboxId,
      projectId: clamped.projectId,
      userId: clamped.userId,
      rootDir,
      timeoutMs: clamped.timeoutMs,
      emitter: this.emitter,
      sessionRepo: this.sessionRepo,
    });

    await this.emitter.emit(
      {
        sessionId: session.id,
        projectId: clamped.projectId,
        userId: clamped.userId,
        provider: "noop",
      },
      "create",
      {
        vendorSandboxId,
        templateId: clamped.templateId ?? null,
        vCpus: clamped.vCpus,
        memMiB: clamped.memMiB,
        timeoutMs: clamped.timeoutMs,
        egressAllowlistSize: effectiveEgress.length,
      },
    );

    return sandbox;
  }
}
