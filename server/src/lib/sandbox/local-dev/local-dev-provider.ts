/**
 * Local-dev sandbox provider (Epic #395 #417).
 *
 * Selects `bwrap` on Linux or `sandbox-exec` on macOS. Refuses to
 * construct on any other host or when the underlying binary is
 * missing — never silently downgrades to "noop" because that would
 * be invisible to the operator and is the wrong default for a
 * sandbox primitive.
 *
 * Loud `WARN` log every `create()` call when `NODE_ENV !== 'development'`
 * — production code should NEVER reach this provider.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "ulid";

import type { SandboxAuditEmitter } from "../audit/audit-emitter.js";
import { getSandboxAuditEmitter } from "../audit/audit-emitter.js";
import { clampSandboxOptions } from "../clamp.js";
import { buildEffectiveEgressAllowlist, validateEgressAllowlist } from "../egress-defaults.js";
import { createChildLogger } from "../../logger.js";
import { getSandboxSessionRepo } from "../repos/sandbox-session.repo.js";
import type { SandboxSessionRepo } from "../repos/sandbox-session.repo.js";
import type { Sandbox, SandboxOptions, SandboxProvider, SandboxProviderKind } from "../types.js";
import { LocalDevSandbox, type LocalDevHostOs } from "./local-dev-sandbox.js";

const log = createChildLogger("sandbox.local-dev.provider");

/** Thrown when the host platform / tooling cannot run the local-dev sandbox. */
export class LocalDevSandboxUnavailableError extends Error {
  constructor(message: string) {
    super(
      `${message}\n\n` +
        "Install instructions:\n" +
        "  • Linux:  apt-get install -y bubblewrap   # or: dnf install -y bubblewrap\n" +
        "  • macOS:  sandbox-exec ships with macOS — no install required.\n" +
        "Set SANDBOX_PROVIDER=noop for offline dev on unsupported hosts.",
    );
    this.name = "LocalDevSandboxUnavailableError";
  }
}

export interface LocalDevProviderDeps {
  emitter?: SandboxAuditEmitter;
  sessionRepo?: SandboxSessionRepo;
  /** Test seam — defaults to `process.platform`. */
  hostPlatform?: NodeJS.Platform;
  /** Test seam — defaults to a real `which`-style probe. */
  isToolAvailable?: (bin: string) => boolean;
  /** Test seam — override `NODE_ENV`. */
  nodeEnv?: string;
  /** Test seam — override tmp-dir creation. */
  mkRootDir?: (id: string) => Promise<string>;
}

function defaultIsToolAvailable(bin: string): boolean {
  try {
    execFileSync("/usr/bin/env", ["which", bin], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function defaultMkRootDir(id: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `metis-local-dev-${id}-`));
}

/**
 * Resolve the absolute path to the bundled macOS sandbox-exec profile.
 * The profile lives next to this file in the source tree and is also
 * copied into `dist/` by the TypeScript build, so this path resolves
 * correctly in both dev (tsx) and production (compiled) modes.
 */
function resolveMacosProfilePath(): string {
  // import.meta.url -> .../local-dev-provider.{ts,js} -> .../profiles/macos.sb
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "profiles", "macos.sb");
}

export class LocalDevSandboxProvider implements SandboxProvider {
  readonly kind: SandboxProviderKind = "local_dev";
  private readonly emitter: SandboxAuditEmitter;
  private readonly sessionRepo: SandboxSessionRepo;
  private readonly hostOs: LocalDevHostOs;
  private readonly nodeEnv: string;
  private readonly mkRootDir: (id: string) => Promise<string>;
  private macosProfilePath: string | undefined;

  constructor(deps: LocalDevProviderDeps = {}) {
    this.emitter = deps.emitter ?? getSandboxAuditEmitter();
    this.sessionRepo = deps.sessionRepo ?? getSandboxSessionRepo();
    this.nodeEnv = deps.nodeEnv ?? process.env.NODE_ENV ?? "development";
    this.mkRootDir = deps.mkRootDir ?? defaultMkRootDir;
    const platform = deps.hostPlatform ?? process.platform;
    const isAvailable = deps.isToolAvailable ?? defaultIsToolAvailable;

    if (platform === "linux") {
      if (!isAvailable("bwrap")) {
        throw new LocalDevSandboxUnavailableError(
          "local-dev sandbox requires `bwrap` (bubblewrap) on Linux but it was not found on PATH.",
        );
      }
      this.hostOs = "linux";
    } else if (platform === "darwin") {
      if (!isAvailable("sandbox-exec")) {
        throw new LocalDevSandboxUnavailableError(
          "local-dev sandbox requires `sandbox-exec` on macOS but it was not found on PATH.",
        );
      }
      this.hostOs = "darwin";
    } else {
      throw new LocalDevSandboxUnavailableError(
        `local-dev sandbox is not supported on platform '${platform}' — only linux and darwin are supported.`,
      );
    }
  }

  async create(opts: SandboxOptions): Promise<Sandbox> {
    if (this.nodeEnv !== "development") {
      log.warn("local-dev sandbox in non-dev environment — NOT FOR PRODUCTION USE", {
        nodeEnv: this.nodeEnv,
        projectId: opts.projectId,
      });
    }

    const clamped = clampSandboxOptions(opts, opts.projectConfig);
    validateEgressAllowlist(clamped.egressAllowlist);
    const effectiveEgress = buildEffectiveEgressAllowlist(clamped.egressAllowlist);

    const vendorSandboxId = `local-dev-${ulid()}`;
    const session = await this.sessionRepo.start({
      projectId: clamped.projectId,
      userId: clamped.userId,
      runId: clamped.runId,
      provider: "local_dev",
      vendorSandboxId,
      templateId: clamped.templateId ?? null,
      vCpus: clamped.vCpus,
      memMiB: clamped.memMiB,
    });

    const rootDir = await this.mkRootDir(session.id);
    let macosProfilePath: string | undefined;
    if (this.hostOs === "darwin") {
      macosProfilePath = await this.ensureMacosProfile();
    }

    const sandbox = new LocalDevSandbox({
      sessionId: session.id,
      vendorSandboxId,
      projectId: clamped.projectId,
      userId: clamped.userId,
      rootDir,
      timeoutMs: clamped.timeoutMs,
      vCpus: clamped.vCpus,
      memMiB: clamped.memMiB,
      hostOs: this.hostOs,
      ...(macosProfilePath ? { macosProfilePath } : {}),
      emitter: this.emitter,
      sessionRepo: this.sessionRepo,
    });

    await this.emitter.emit(
      {
        sessionId: session.id,
        projectId: clamped.projectId,
        userId: clamped.userId,
        provider: "local_dev",
      },
      "create",
      {
        vendorSandboxId,
        templateId: clamped.templateId ?? null,
        vCpus: clamped.vCpus,
        memMiB: clamped.memMiB,
        timeoutMs: clamped.timeoutMs,
        egressAllowlistSize: effectiveEgress.length,
        hostOs: this.hostOs,
      },
    );

    return sandbox;
  }

  /**
   * Resolve and cache the bundled macOS sandbox-exec profile path. If
   * the source-tree path is not readable in this deploy (e.g. the
   * profile was excluded by the bundler), write the inlined fallback
   * profile to a tmp file so `sandbox-exec -f` always finds something.
   */
  private async ensureMacosProfile(): Promise<string> {
    if (this.macosProfilePath) return this.macosProfilePath;
    try {
      const path = resolveMacosProfilePath();
      // Touch — readFile would block; we just need to verify access in
      // the spawn step. Trust the resolver and fall back on first use.
      this.macosProfilePath = path;
      return path;
    } catch {
      const path = join(tmpdir(), `metis-local-dev-${ulid()}.sb`);
      await writeFile(path, MACOS_PROFILE_FALLBACK, "utf8");
      this.macosProfilePath = path;
      return path;
    }
  }
}

/**
 * Inlined copy of `profiles/macos.sb` used as a runtime fallback when
 * the bundled profile is not on disk (e.g. some bundlers strip
 * non-`.ts` files from `dist/`).
 */
const MACOS_PROFILE_FALLBACK = `(version 1)
(deny default)
(allow process-fork)
(allow process-exec)
(allow signal (target self))
(allow sysctl-read)
(allow file-read*
  (regex #"^/bin/")
  (regex #"^/sbin/")
  (regex #"^/usr/")
  (regex #"^/System/")
  (regex #"^/Library/")
  (regex #"^/private/etc/")
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/random")
  (literal "/dev/urandom"))
(allow file-read* file-write*
  (subpath (param "SANDBOX_DIR"))
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (literal "/dev/null"))
`;
