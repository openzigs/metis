/**
 * Daytona sandbox provider (Epic #395 #416).
 *
 * Lazy-loads `@daytona/sdk` at first `create()` so the SDK is not a
 * hard requirement of the slim image. When the SDK is missing or
 * `DAYTONA_API_KEY` is unset we throw a structured `Error` with
 * `code: 'DAYTONA_UNAVAILABLE'`.
 *
 * Same egress + audit contracts as E2B. Daytona's network policy is
 * applied via the per-sandbox `target` argument on `create` plus the
 * shared `egress-defaults.ts` allowlist that Daytona enforces in its
 * VPC-style overlay (the SDK accepts a `networkAllowList` field — see
 * Daytona docs §"Sandbox networking").
 *
 * Tests inject a stub via `clientFactory` so they never reach the
 * real SDK / network.
 */
import { ulid } from "ulid";

import type { SandboxAuditEmitter } from "../audit/audit-emitter.js";
import { getSandboxAuditEmitter } from "../audit/audit-emitter.js";
import { clampSandboxOptions } from "../clamp.js";
import { buildEffectiveEgressAllowlist, validateEgressAllowlist } from "../egress-defaults.js";
import { createChildLogger } from "../../logger.js";
import { getSandboxSessionRepo } from "../repos/sandbox-session.repo.js";
import type { SandboxSessionRepo } from "../repos/sandbox-session.repo.js";
import type { Sandbox, SandboxOptions, SandboxProvider, SandboxProviderKind } from "../types.js";
import type { DaytonaSandboxLike } from "./daytona-sandbox.js";
import { DaytonaSandbox } from "./daytona-sandbox.js";

const log = createChildLogger("sandbox.daytona.provider");

export interface DaytonaClientCreateOptions {
  apiKey: string;
  apiUrl?: string;
  target?: string;
  templateId?: string;
  timeoutMs: number;
  vCpus: number;
  memMiB: number;
  /** Effective egress allowlist (post-default merge). */
  networkAllowList: readonly string[];
}

export type DaytonaClientFactory = (
  opts: DaytonaClientCreateOptions,
) => Promise<DaytonaSandboxLike>;

export interface DaytonaProviderDeps {
  emitter?: SandboxAuditEmitter;
  sessionRepo?: SandboxSessionRepo;
  /** Test seam — replace the SDK lookup. */
  clientFactory?: DaytonaClientFactory;
  /** Override for `DAYTONA_API_KEY` (tests). */
  apiKey?: string;
  /** Override for `DAYTONA_API_URL` (tests). */
  apiUrl?: string;
  /** Override for `DAYTONA_TARGET` (tests). */
  target?: string;
}

/** `code` field on the structured error thrown when the SDK is unavailable. */
export const DAYTONA_UNAVAILABLE = "DAYTONA_UNAVAILABLE";

const DEFAULT_FACTORY: DaytonaClientFactory = async (opts) => {
  let mod: unknown;
  try {
    mod = await import("@daytona/sdk" as string);
  } catch {
    const err = new Error(
      "@daytona/sdk is not installed in this image. " +
        "Set SANDBOX_PROVIDER=noop for offline dev or rebuild with the daytona extra.",
    ) as Error & { code: string };
    err.code = DAYTONA_UNAVAILABLE;
    throw err;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ClientCtor: any = (mod as any)?.Daytona ?? (mod as any)?.default;
  if (!ClientCtor) {
    const err = new Error("@daytona/sdk shape changed — Daytona constructor not found") as Error & {
      code: string;
    };
    err.code = DAYTONA_UNAVAILABLE;
    throw err;
  }
  const client = new ClientCtor({
    apiKey: opts.apiKey,
    ...(opts.apiUrl ? { apiUrl: opts.apiUrl } : {}),
    ...(opts.target ? { target: opts.target } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const created: any = await client.create({
    ...(opts.templateId ? { image: opts.templateId } : {}),
    timeout: opts.timeoutMs,
    resources: { cpu: opts.vCpus, memory: opts.memMiB },
    networkAllowList: opts.networkAllowList,
  });
  return created as DaytonaSandboxLike;
};

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly kind: SandboxProviderKind = "daytona";
  private readonly emitter: SandboxAuditEmitter;
  private readonly sessionRepo: SandboxSessionRepo;
  private readonly clientFactory: DaytonaClientFactory;
  private readonly apiKey: string | undefined;
  private readonly apiUrl: string | undefined;
  private readonly target: string | undefined;

  constructor(deps: DaytonaProviderDeps = {}) {
    this.emitter = deps.emitter ?? getSandboxAuditEmitter();
    this.sessionRepo = deps.sessionRepo ?? getSandboxSessionRepo();
    this.clientFactory = deps.clientFactory ?? DEFAULT_FACTORY;
    this.apiKey = deps.apiKey ?? process.env.DAYTONA_API_KEY?.trim();
    this.apiUrl = deps.apiUrl ?? process.env.DAYTONA_API_URL?.trim();
    this.target = deps.target ?? process.env.DAYTONA_TARGET?.trim();
  }

  async create(opts: SandboxOptions): Promise<Sandbox> {
    if (!this.apiKey) {
      const err = new Error(
        "DAYTONA_API_KEY is not configured — refusing to create sandbox",
      ) as Error & { code: string };
      err.code = DAYTONA_UNAVAILABLE;
      throw err;
    }

    const clamped = clampSandboxOptions(opts, opts.projectConfig);
    validateEgressAllowlist(clamped.egressAllowlist);
    const effectiveEgress = buildEffectiveEgressAllowlist(clamped.egressAllowlist);

    const placeholderVendorId = `daytona-pending-${ulid()}`;
    const session = await this.sessionRepo.start({
      projectId: clamped.projectId,
      userId: clamped.userId,
      runId: clamped.runId,
      provider: "daytona",
      vendorSandboxId: placeholderVendorId,
      templateId: clamped.templateId ?? null,
      vCpus: clamped.vCpus,
      memMiB: clamped.memMiB,
    });

    let client: DaytonaSandboxLike;
    try {
      client = await this.clientFactory({
        apiKey: this.apiKey,
        ...(this.apiUrl ? { apiUrl: this.apiUrl } : {}),
        ...(this.target ? { target: this.target } : {}),
        ...(clamped.templateId ? { templateId: clamped.templateId } : {}),
        timeoutMs: clamped.timeoutMs,
        vCpus: clamped.vCpus,
        memMiB: clamped.memMiB,
        networkAllowList: effectiveEgress,
      });
    } catch (err) {
      log.error("daytona.create_failed", {
        sessionId: session.id,
        projectId: clamped.projectId,
        error: (err as Error).message,
      });
      throw err;
    }

    const vendorSandboxId = client.id ?? placeholderVendorId;
    const sandbox = new DaytonaSandbox({
      sessionId: session.id,
      vendorSandboxId,
      projectId: clamped.projectId,
      userId: clamped.userId,
      client,
      timeoutMs: clamped.timeoutMs,
      vCpus: clamped.vCpus,
      memMiB: clamped.memMiB,
      emitter: this.emitter,
      sessionRepo: this.sessionRepo,
    });

    await this.emitter.emit(
      {
        sessionId: session.id,
        projectId: clamped.projectId,
        userId: clamped.userId,
        provider: "daytona",
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
