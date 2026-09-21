/**
 * Epic #165 (#114) — HookSubscription service.
 *
 * Persists per-project hook subscriptions and exposes a small CRUD surface
 * used by `/api/projects/:id/hooks` and the `/settings/hooks` UI page. Webhook
 * subscriptions are dispatched at emit-time via {@link runWebhook}.
 */
import dns from "node:dns/promises";
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import { audit } from "../audit/audit-service.js";
import {
  SDK_HOOK_EVENTS,
  SDK_HOOK_HANDLER_KINDS,
  type SdkHookEvent,
  type SdkHookHandlerKind,
  type HookSubscriptionDto,
} from "@metis/shared";
import {
  assertPublicHost,
  parseWebhookUrl,
  pinnedFetch,
  type DispatcherLike,
  type PinnedHost,
} from "../finops/channels/webhook-sender.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("hooks-service");

export class HookConfigError extends Error {}

/**
 * DNS resolver shape consumed by the outbound webhook SSRF guard. Injectable so
 * tests can drive the private/public decision without touching real DNS.
 */
export type WebhookHostResolver = (host: string) => Promise<string[]>;

export interface HookServiceOptions {
  /** Override the DNS resolver used by the outbound-webhook egress guard. */
  resolver?: WebhookHostResolver;
}

const defaultHostResolver: WebhookHostResolver = async (host) => {
  // IP literals resolve locally (no network); hostnames hit the OS resolver.
  const records = await dns.lookup(host, { all: true });
  return records.map((r) => r.address);
};

/**
 * SECURITY (SSRF / OWASP A10): a webhook subscription's target URL is
 * attacker-influenced config. Before persisting a `webhook` handler we route
 * the URL through the SAME egress guard the FinOps alert sender uses
 * (`parseWebhookUrl` + `assertPublicHost`): scheme is restricted to http(s) and
 * the host must NOT resolve to a private / loopback / link-local / ULA / cloud
 * metadata address. Reusing the shared guard keeps a single SSRF threat model
 * across every outbound-webhook surface. Rejection surfaces as a
 * {@link HookConfigError} (→ 400) — it is invalid caller input, not an authz
 * denial. This config-time check is the first line of defence; the actual
 * outbound request in {@link runWebhook} independently re-validates and pins the
 * connection at send time (via the shared `pinnedFetch`), so a host repointed to
 * an internal address AFTER creation (DNS rebinding / TOCTOU) is still rejected.
 */
async function assertWebhookEgressAllowed(
  handlerKind: SdkHookHandlerKind,
  config: Record<string, unknown> | undefined,
  resolver: WebhookHostResolver,
): Promise<void> {
  if (handlerKind !== "webhook") return;
  const rawUrl = config?.url;
  // The structural `validate()` guarantees a string https?:// url reaches here.
  if (typeof rawUrl !== "string") return;
  let url: URL;
  try {
    url = parseWebhookUrl(rawUrl);
  } catch (err) {
    throw new HookConfigError((err as Error).message);
  }
  try {
    await assertPublicHost(url.hostname, resolver);
  } catch (err) {
    throw new HookConfigError(`Webhook url is not allowed: ${(err as Error).message}`);
  }
}

export interface UpsertHookInput {
  projectId: string;
  event: SdkHookEvent;
  handlerKind?: SdkHookHandlerKind;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

function validate(input: UpsertHookInput): void {
  if (!SDK_HOOK_EVENTS.includes(input.event)) {
    throw new HookConfigError(`Unsupported event: ${input.event}`);
  }
  const kind = input.handlerKind ?? "webhook";
  if (!SDK_HOOK_HANDLER_KINDS.includes(kind)) {
    throw new HookConfigError(`Unsupported handlerKind: ${kind}`);
  }
  if (kind === "script") {
    throw new HookConfigError("Script handlers are deferred to v1.2 — use 'webhook' or 'builtin'");
  }
  if (kind === "webhook") {
    const url = input.config?.url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw new HookConfigError("Webhook handlers require a https?:// url");
    }
  }
}

function toDto(row: {
  id: string;
  projectId: string;
  event: string;
  handlerKind: string;
  config: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): HookSubscriptionDto {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(row.config);
  } catch {
    parsed = {};
  }
  return {
    id: row.id,
    projectId: row.projectId,
    event: row.event as SdkHookEvent,
    handlerKind: row.handlerKind as SdkHookHandlerKind,
    config: parsed,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listSubscriptions(projectId: string): Promise<HookSubscriptionDto[]> {
  const rows = await prisma.hookSubscription.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toDto);
}

export async function listEnabledFor(
  projectId: string,
  event: SdkHookEvent,
): Promise<HookSubscriptionDto[]> {
  const rows = await prisma.hookSubscription.findMany({
    where: { projectId, event, enabled: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toDto);
}

export async function createSubscription(
  input: UpsertHookInput,
  actorId?: string,
  opts?: HookServiceOptions,
): Promise<HookSubscriptionDto> {
  validate(input);
  await assertWebhookEgressAllowed(
    input.handlerKind ?? "webhook",
    input.config,
    opts?.resolver ?? defaultHostResolver,
  );
  const row = await prisma.hookSubscription.create({
    data: {
      projectId: input.projectId,
      event: input.event,
      handlerKind: input.handlerKind ?? "webhook",
      config: JSON.stringify(input.config ?? {}),
      enabled: input.enabled ?? true,
    },
  });
  audit({
    actor: actorId ? { id: actorId } : null,
    action: "hook.subscription.created",
    target: { type: "hook_subscription", id: row.id },
    metadata: { projectId: input.projectId, event: input.event },
  });
  return toDto(row);
}

export async function updateSubscription(
  projectId: string,
  id: string,
  patch: Partial<UpsertHookInput> & { enabled?: boolean },
  actorId?: string,
  opts?: HookServiceOptions,
): Promise<HookSubscriptionDto> {
  // SECURITY (OWASP A01 / BOLA): scope the lookup to the caller's project so a
  // hook id belonging to another project is invisible — 404, no existence
  // oracle, never a cross-tenant mutation.
  const existing = await prisma.hookSubscription.findFirst({ where: { id, projectId } });
  if (!existing) throw new AppError(404, "NOT_FOUND", "Hook subscription not found");
  if (patch.event || patch.handlerKind || patch.config) {
    const effectiveKind = (patch.handlerKind ?? existing.handlerKind) as SdkHookHandlerKind;
    const effectiveConfig = patch.config ?? safeParse(existing.config);
    validate({
      projectId: existing.projectId,
      event: (patch.event ?? existing.event) as SdkHookEvent,
      handlerKind: effectiveKind,
      config: effectiveConfig,
    });
    await assertWebhookEgressAllowed(
      effectiveKind,
      effectiveConfig,
      opts?.resolver ?? defaultHostResolver,
    );
  }
  const row = await prisma.hookSubscription.update({
    where: { id },
    data: {
      event: patch.event,
      handlerKind: patch.handlerKind,
      config: patch.config != null ? JSON.stringify(patch.config) : undefined,
      enabled: patch.enabled,
    },
  });
  audit({
    actor: actorId ? { id: actorId } : null,
    action: "hook.subscription.updated",
    target: { type: "hook_subscription", id: row.id },
  });
  return toDto(row);
}

export async function deleteSubscription(
  projectId: string,
  id: string,
  actorId?: string,
): Promise<void> {
  // SECURITY (OWASP A01 / BOLA): scope the delete to the caller's project. A
  // hook id from another project deletes 0 rows → 404 (no existence oracle).
  const { count } = await prisma.hookSubscription.deleteMany({ where: { id, projectId } });
  if (count === 0) throw new AppError(404, "NOT_FOUND", "Hook subscription not found");
  audit({
    actor: actorId ? { id: actorId } : null,
    action: "hook.subscription.deleted",
    target: { type: "hook_subscription", id },
  });
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Test seams for {@link runWebhook}'s send-time SSRF defence. */
export interface RunWebhookOptions {
  /** Override the DNS resolver (models DNS rebinding in tests). */
  resolver?: (host: string) => Promise<string[]>;
  /** Override the pinned-dispatcher factory (tests). */
  dispatcherFactory?: (pinned: PinnedHost) => Promise<DispatcherLike>;
}

/**
 * Best-effort webhook dispatch. Returns true on 2xx, false otherwise. Failures
 * are logged but never re-thrown (a misbehaving webhook must NOT abort the
 * session).
 *
 * SECURITY (SSRF / OWASP A10): the target URL was validated at config time, but
 * that check is bypassable at send time (a public host repointed to
 * 169.254.169.254 / loopback via DNS rebinding, or a 30x redirect into the
 * metadata service). We therefore dispatch through the SAME `pinnedFetch`
 * primitive the FinOps alert sender uses: it re-resolves and public-asserts the
 * host NOW, pins the socket to the validated IP, and refuses to follow redirects
 * (`redirect: "error"`). A host that resolves to a private/metadata address at
 * send time throws → we return false without ever opening the connection.
 */
export async function runWebhook(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  fetchImpl: typeof fetch = fetch,
  opts: RunWebhookOptions = {},
): Promise<boolean> {
  try {
    const res = await pinnedFetch({
      url,
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      fetchFn: fetchImpl,
      resolver: opts.resolver,
      dispatcherFactory: opts.dispatcherFactory,
    });
    if (!res.ok) {
      log.warn("Webhook returned non-2xx", { url, status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    log.warn("Webhook dispatch failed", { url, error: (err as Error).message });
    return false;
  }
}
