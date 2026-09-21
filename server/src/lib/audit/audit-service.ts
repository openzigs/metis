/**
 * Audit log service.
 *
 * Writes to the `AuditLog` Prisma model. By default ONLY hashes of args /
 * results are persisted — full payloads stay out of the durable store unless
 * the caller explicitly opts in with `deepAudit: true`.
 *
 * Sensitive headers/keys (`Authorization`, `Cookie`, `*_SECRET`, `*_TOKEN`,
 * `*_KEY`, `password`) are redacted before hashing AND before the optional
 * deep-audit metadata payload is serialized.
 *
 * REDACTION_SINK_POLICY: exempt-token-counts
 *
 * An enumerated token *count* carrying a numeric value is not a credential and
 * is persisted in the clear (#1268). Persistence raises the cost of leaking a
 * credential, not of recording a count — and per-actor, per-target token spend
 * is exactly the accounting an audit record exists to carry. Rationale and the
 * other two sinks' policies: `docs/decisions/0008-redaction-sinks.md`.
 *
 * Writes are non-blocking: `record()` returns immediately and the actual
 * Prisma insert runs on a microtask queue. Failures are logged but never
 * surface to the caller.
 */
import crypto from "node:crypto";
import { createChildLogger, isTokenCountExempt } from "../logger.js";
import { prisma } from "../prisma.js";

const log = createChildLogger("audit");

const SENSITIVE_KEY_PATTERNS = [
  /authorization/i,
  /cookie/i,
  /set-cookie/i,
  /password/i,
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /private[-_]?key/i,
  /credential/i,
];

const REDACTED = "[REDACTED]";

export interface AuditEntry {
  /** User id of the actor; `null` for system-initiated actions. */
  actorId?: string | null;
  /** Verb-style identifier — e.g. `user.login`, `vault.read`, `analysis.start`. */
  action: string;
  /** Logical type of the affected resource — `user`, `secret`, `project`, ... */
  targetType: string;
  /** Stable identifier of the affected resource (or "n/a"). */
  targetId: string;
  /** Optional inputs the action used. Hashed by default. */
  args?: Record<string, unknown>;
  /** Optional outputs the action returned. Hashed by default. */
  result?: Record<string, unknown>;
  /** Free-form metadata persisted alongside the entry. Always redacted. */
  metadata?: Record<string, unknown>;
  /** When `true`, writes the redacted args/result JSON in addition to hashes. */
  deepAudit?: boolean;
}

export class AuditService {
  private pending = 0;

  /**
   * Record an audit event. Returns immediately — the database write is queued.
   */
  record(entry: AuditEntry): void {
    this.pending += 1;
    queueMicrotask(() => {
      void this.persist(entry).finally(() => {
        this.pending -= 1;
      });
    });
  }

  /**
   * Async variant for callers that genuinely need to await the write
   * (e.g. tests). Production code paths should prefer `record`.
   */
  async recordAndFlush(entry: AuditEntry): Promise<void> {
    await this.persist(entry);
  }

  /** Returns the count of in-flight writes (for graceful shutdown). */
  get inFlight(): number {
    return this.pending;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async persist(entry: AuditEntry): Promise<void> {
    try {
      await prisma.auditLog.create({ data: buildAuditLogData(entry) });
    } catch (err) {
      log.error("Audit write failed", {
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        error: (err as Error).message,
      });
    }
  }
}

let singleton: AuditService | null = null;
export function getAuditService(): AuditService {
  if (!singleton) singleton = new AuditService();
  return singleton;
}

/** Test helper. */
export function __resetAuditSingleton(): void {
  singleton = null;
}

/**
 * Convenience wrapper:  `audit({ actor, action, target, metadata })`.
 *
 * Resolves the singleton, builds the entry, and queues the write.
 */
export function audit(input: {
  actor?: { id: string | null } | string | null;
  action: string;
  target: { type: string; id: string };
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  deepAudit?: boolean;
}): void {
  const actorId = typeof input.actor === "string" ? input.actor : (input.actor?.id ?? null);
  getAuditService().record({
    actorId,
    action: input.action,
    targetType: input.target.type,
    targetId: input.target.id,
    args: input.args,
    result: input.result,
    metadata: input.metadata,
    deepAudit: input.deepAudit,
  });
}

/**
 * Build the exact `AuditLog.create` data payload for an entry — identical
 * redaction + hashing to the queued path. Exported for callers that must
 * persist audit evidence ATOMICALLY with the writes it describes, via
 * `tx.auditLog.create({ data: buildAuditLogData(...) })` inside a Prisma
 * transaction — e.g. review sign-off records (epic #609), where a silently
 * lost audit row is an integrity defect rather than an ops annoyance.
 */
export function buildAuditLogData(entry: AuditEntry): {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  argsHash: string | null;
  resultHash: string | null;
  metadata: string | null;
} {
  const argsHash = entry.args ? hashJson(redact(entry.args)) : null;
  const resultHash = entry.result ? hashJson(redact(entry.result)) : null;
  return {
    actorId: entry.actorId ?? null,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    argsHash,
    resultHash,
    metadata: buildMetadata(entry, argsHash, resultHash),
  };
}

// ── Helpers (exported for unit tests) ──────────────────────────────────────

/**
 * True when this sink must blank the value under `key`.
 *
 * The token-count exemption (`isTokenCountExempt`) is the predicate shared with
 * `logger.ts`; {@link SENSITIVE_KEY_PATTERNS} is this sink's own denylist. See
 * the REDACTION_SINK_POLICY note at the top of the file.
 */
function isSensitiveAuditKey(key: string, value: unknown): boolean {
  if (isTokenCountExempt(key, value)) return false;
  return SENSITIVE_KEY_PATTERNS.some((rx) => rx.test(key));
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveAuditKey(k, v)) {
        out[k] = REDACTED;
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function hashJson(value: unknown): string {
  const canonical = JSON.stringify(value, Object.keys(value as object).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function buildMetadata(
  entry: AuditEntry,
  argsHash: string | null,
  resultHash: string | null,
): string | null {
  const meta: Record<string, unknown> = {};
  if (entry.metadata) Object.assign(meta, redact(entry.metadata) as Record<string, unknown>);
  if (entry.deepAudit) {
    if (entry.args) meta.args = redact(entry.args);
    if (entry.result) meta.result = redact(entry.result);
  }
  if (argsHash) meta.argsHashAlgorithm = "sha256";
  if (resultHash) meta.resultHashAlgorithm = "sha256";
  return Object.keys(meta).length ? JSON.stringify(meta) : null;
}
