/**
 * E2B sandbox provider (Epic #395 #411).
 *
 * Lazy-loads `@e2b/code-interpreter` at first `create()` so the SDK is
 * not a hard requirement of the slim image — callers running with
 * `SANDBOX_PROVIDER=noop` (default) never reach the import. When the
 * SDK is missing or `E2B_API_KEY` is unset we throw a structured
 * `Error` with `code: 'E2B_UNAVAILABLE'`.
 *
 * Tests inject a stub via `e2bClientFactory` so they never reach the
 * real SDK / network.
 */
import { ulid } from "ulid";

import type { SandboxAuditEmitter } from "../audit/audit-emitter.js";
import { getSandboxAuditEmitter } from "../audit/audit-emitter.js";
import { clampSandboxOptions } from "../clamp.js";
import { createChildLogger } from "../../logger.js";
import { getSandboxSessionRepo } from "../repos/sandbox-session.repo.js";
import type { SandboxSessionRepo } from "../repos/sandbox-session.repo.js";
import type { Sandbox, SandboxOptions, SandboxProvider, SandboxProviderKind } from "../types.js";
import type { E2BSandboxLike } from "./e2b-sandbox.js";
import { E2BSandbox } from "./e2b-sandbox.js";
import type { E2BFirewallShape, E2BFirewallShapeName } from "./firewall.js";
import { buildE2BFirewallShapes } from "./firewall.js";

const log = createChildLogger("sandbox.e2b.provider");

/**
 * Process-wide cache for the firewall payload shape that the live SDK
 * accepts. Set on the first successful `create()` so subsequent
 * sandboxes skip the probe loop.
 */
let detectedFirewallShape: E2BFirewallShapeName | null = null;

/** Test helper — clears the detected shape so the probe runs again. */
export function __resetDetectedFirewallShape(): void {
  detectedFirewallShape = null;
}

/** Options the factory passes to the underlying SDK constructor. */
export interface E2BClientCreateOptions {
  apiKey: string;
  domain?: string;
  templateId?: string;
  timeoutMs: number;
  vCpus: number;
  memMiB: number;
  /**
   * Pre-built firewall payload fragment to merge into `Sandbox.create`.
   * Either `{ firewall: ... }` or `{ network: ... }` depending on which
   * shape the SDK accepts (probed at runtime by the provider).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  firewallPayload: Record<string, any>;
}

export type E2BClientFactory = (opts: E2BClientCreateOptions) => Promise<E2BSandboxLike>;

export interface E2BProviderDeps {
  emitter?: SandboxAuditEmitter;
  sessionRepo?: SandboxSessionRepo;
  /** Test seam — replace the SDK lookup. */
  clientFactory?: E2BClientFactory;
  /** Override for `E2B_API_KEY` (tests). */
  apiKey?: string;
  /** Override for `E2B_DOMAIN` (tests). */
  domain?: string;
}

/** `code` field on the structured error thrown when the SDK is unavailable. */
export const E2B_UNAVAILABLE = "E2B_UNAVAILABLE";

const DEFAULT_FACTORY: E2BClientFactory = async (opts) => {
  let mod: unknown;
  try {
    mod = await import("@e2b/code-interpreter" as string);
  } catch {
    const err = new Error(
      "@e2b/code-interpreter is not installed in this image. " +
        "Set SANDBOX_PROVIDER=noop for offline dev or rebuild with the e2b extra.",
    ) as Error & { code: string };
    err.code = E2B_UNAVAILABLE;
    throw err;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SandboxCtor = (mod as any)?.Sandbox ?? (mod as any)?.default;
  if (!SandboxCtor || typeof SandboxCtor.create !== "function") {
    const err = new Error(
      "@e2b/code-interpreter shape changed — Sandbox.create not found",
    ) as Error & { code: string };
    err.code = E2B_UNAVAILABLE;
    throw err;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const created: any = await SandboxCtor.create({
    apiKey: opts.apiKey,
    ...(opts.domain ? { domain: opts.domain } : {}),
    ...(opts.templateId ? { template: opts.templateId } : {}),
    timeoutMs: opts.timeoutMs,
    resources: { vCpus: opts.vCpus, memMiB: opts.memMiB },
    ...opts.firewallPayload,
  });
  return created as E2BSandboxLike;
};

export class E2BSandboxProvider implements SandboxProvider {
  readonly kind: SandboxProviderKind = "e2b";
  private readonly emitter: SandboxAuditEmitter;
  private readonly sessionRepo: SandboxSessionRepo;
  private readonly clientFactory: E2BClientFactory;
  private readonly apiKey: string | undefined;
  private readonly domain: string | undefined;

  constructor(deps: E2BProviderDeps = {}) {
    this.emitter = deps.emitter ?? getSandboxAuditEmitter();
    this.sessionRepo = deps.sessionRepo ?? getSandboxSessionRepo();
    this.clientFactory = deps.clientFactory ?? DEFAULT_FACTORY;
    this.apiKey = deps.apiKey ?? process.env.E2B_API_KEY?.trim();
    this.domain = deps.domain ?? process.env.E2B_DOMAIN?.trim();
  }

  async create(opts: SandboxOptions): Promise<Sandbox> {
    if (!this.apiKey) {
      const err = new Error(
        "E2B_API_KEY is not configured — refusing to create sandbox",
      ) as Error & { code: string };
      err.code = E2B_UNAVAILABLE;
      throw err;
    }

    const clamped = clampSandboxOptions(opts, opts.projectConfig);
    // `clampSandboxOptions` already runs `validateEgressAllowlist`;
    // `buildE2BFirewallShapes` runs it once more as defense-in-depth.
    const { hosts: effectiveEgress, shapes } = buildE2BFirewallShapes(clamped.egressAllowlist);

    const placeholderVendorId = `e2b-pending-${ulid()}`;
    const session = await this.sessionRepo.start({
      projectId: clamped.projectId,
      userId: clamped.userId,
      runId: clamped.runId,
      provider: "e2b",
      vendorSandboxId: placeholderVendorId,
      templateId: clamped.templateId ?? null,
      vCpus: clamped.vCpus,
      memMiB: clamped.memMiB,
    });

    const client = await this.createClientWithFirewallProbe(clamped, shapes);

    const vendorSandboxId = client.sandboxId ?? placeholderVendorId;
    const sandbox = new E2BSandbox({
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
        provider: "e2b",
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

  /**
   * Try each candidate firewall payload shape against the SDK in order.
   *
   * On the first success, cache the shape name process-wide and log it
   * once at INFO. On subsequent calls, the cached shape is tried first
   * and (if it still works) no other shape is attempted.
   *
   * If ALL shapes fail, throw — never silently fall back to a SDK call
   * with no firewall payload (that would default-allow all egress and
   * undermine the entire deny-by-default posture).
   */
  private async createClientWithFirewallProbe(
    clamped: ReturnType<typeof clampSandboxOptions>,
    shapes: readonly E2BFirewallShape[],
  ): Promise<E2BSandboxLike> {
    // If we've already detected a working shape, try it first.
    const ordered: E2BFirewallShape[] = [];
    if (detectedFirewallShape !== null) {
      const cached = shapes.find((s) => s.name === detectedFirewallShape);
      if (cached) ordered.push(cached);
      for (const s of shapes) {
        if (s.name !== detectedFirewallShape) ordered.push(s);
      }
    } else {
      ordered.push(...shapes);
    }

    const errors: Array<{ shape: E2BFirewallShapeName; error: string }> = [];
    for (const shape of ordered) {
      try {
        const client = await this.clientFactory({
          apiKey: this.apiKey as string,
          ...(this.domain ? { domain: this.domain } : {}),
          ...(clamped.templateId ? { templateId: clamped.templateId } : {}),
          timeoutMs: clamped.timeoutMs,
          vCpus: clamped.vCpus,
          memMiB: clamped.memMiB,
          firewallPayload: shape.payload,
        });
        if (detectedFirewallShape !== shape.name) {
          detectedFirewallShape = shape.name;
          log.info("e2b firewall shape detected", { shape: shape.name });
        }
        return client;
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        errors.push({ shape: shape.name, error: message });
        log.warn("e2b firewall shape rejected, trying next", {
          shape: shape.name,
          error: message,
        });
      }
    }

    // All shapes rejected — refuse to create a sandbox without a firewall.
    const summary = errors.map((e) => `${e.shape}: ${e.error}`).join("; ");
    const finalErr = new Error(
      `E2B firewall shape probe failed — refusing to create sandbox without verified deny-by-default policy. Tried: ${summary}`,
    ) as Error & { code: string };
    finalErr.code = E2B_UNAVAILABLE;
    throw finalErr;
  }
}
