/**
 * Issue #580 (epic #63) — PagerDuty Events API v2 client.
 *
 * A thin, dependency-free client over the v2 "enqueue" endpoint
 * (https://events.pagerduty.com/v2/enqueue). It speaks exactly two actions:
 *
 *   - `trigger`  — open (or update, via a stable dedup_key) an incident.
 *   - `resolve`  — resolve the incident keyed by the same dedup_key.
 *
 * Design notes:
 *   - Uses the canonical SSRF-safe {@link safeFetch} helper (Node 22 global fetch
 *     under the hood). PagerDuty's host is public, but routing every outbound call
 *     through `safeFetch` keeps the egress policy uniform (defense in depth).
 *   - No SDK dependency — the v2 protocol is a single JSON POST.
 *   - Every request carries an AbortSignal-backed timeout so a hung PagerDuty
 *     endpoint can never wedge a caller's critical path.
 *   - SECURITY: the routing key is sent only in the request body and is NEVER
 *     placed in a thrown error message, log line, or the returned result.
 */
import { safeFetch } from "../net/safe-fetch.js";

/** The canonical v2 enqueue endpoint. */
export const PAGERDUTY_ENQUEUE_URL = "https://events.pagerduty.com/v2/enqueue";

/** Default per-request timeout (ms). */
const DEFAULT_TIMEOUT_MS = 8000;

/** v2 severities. Sev-1 alerting uses `critical`. */
export type PagerDutySeverity = "critical" | "error" | "warning" | "info";

export interface TriggerInput {
  /** The PagerDuty service routing (integration) key. Secret — never logged. */
  routingKey: string;
  /** Stable key that dedups/collapses repeated triggers into one incident. */
  dedupKey: string;
  /** Human-readable incident summary (PagerDuty truncates at 1024 chars). */
  summary: string;
  /** The affected system emitting the event (e.g. "metis/publishing"). */
  source: string;
  /** Defaults to `critical` for sev-1. */
  severity?: PagerDutySeverity;
  /** Optional component/group/class metadata. */
  component?: string;
  group?: string;
  eventClass?: string;
  /**
   * Arbitrary structured context. MUST NOT contain secrets/PII — callers are
   * responsible for sanitizing what they put here.
   */
  customDetails?: Record<string, unknown>;
}

export interface ResolveInput {
  routingKey: string;
  dedupKey: string;
}

export interface PagerDutyResult {
  /** Echoed dedup key PagerDuty associated with the incident. */
  dedupKey: string | null;
  /** PagerDuty status string ("success"). */
  status: string;
  message: string | null;
}

export interface PagerDutyEventsClientOptions {
  /** Override the enqueue URL (tests / regional endpoints). */
  endpoint?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Injected fetch implementation (tests). Forwarded to {@link safeFetch}. */
  fetchImpl?: typeof fetch;
}

/** Raised when PagerDuty returns a non-2xx response. Carries the HTTP status. */
export class PagerDutyApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "PagerDutyApiError";
  }
}

interface EnqueueBody {
  routing_key: string;
  event_action: "trigger" | "resolve";
  dedup_key: string;
  payload?: {
    summary: string;
    source: string;
    severity: PagerDutySeverity;
    component?: string;
    group?: string;
    class?: string;
    custom_details?: Record<string, unknown>;
  };
}

export class PagerDutyEventsClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: PagerDutyEventsClientOptions = {}) {
    this.endpoint = opts.endpoint ?? PAGERDUTY_ENQUEUE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl;
  }

  /** Open/update an incident. Returns the PagerDuty result on 2xx. */
  async trigger(input: TriggerInput): Promise<PagerDutyResult> {
    const body: EnqueueBody = {
      routing_key: input.routingKey,
      event_action: "trigger",
      dedup_key: input.dedupKey,
      payload: {
        summary: input.summary,
        source: input.source,
        severity: input.severity ?? "critical",
        ...(input.component ? { component: input.component } : {}),
        ...(input.group ? { group: input.group } : {}),
        ...(input.eventClass ? { class: input.eventClass } : {}),
        ...(input.customDetails ? { custom_details: input.customDetails } : {}),
      },
    };
    return this.send(body);
  }

  /** Resolve the incident identified by `dedupKey`. */
  async resolve(input: ResolveInput): Promise<PagerDutyResult> {
    const body: EnqueueBody = {
      routing_key: input.routingKey,
      event_action: "resolve",
      dedup_key: input.dedupKey,
    };
    return this.send(body);
  }

  private async send(body: EnqueueBody): Promise<PagerDutyResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const res = await safeFetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        fetchImpl: this.fetchImpl,
      });

      const text = await res.text();
      let parsed: { status?: string; message?: string; dedup_key?: string } = {};
      try {
        parsed = text ? (JSON.parse(text) as typeof parsed) : {};
      } catch {
        parsed = {};
      }

      if (!res.ok) {
        // NEVER include the routing key (it's not echoed by PagerDuty, but be
        // explicit): report only the status and PagerDuty's own status string.
        throw new PagerDutyApiError(
          res.status,
          `PagerDuty enqueue failed (${res.status}): ${parsed.status ?? "unknown error"}`,
        );
      }

      return {
        dedupKey: parsed.dedup_key ?? body.dedup_key ?? null,
        status: parsed.status ?? "success",
        message: parsed.message ?? null,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
