/**
 * Session registry for the copilot-svc sidecar.
 *
 * Each entry holds a live `CopilotSessionLike` object returned by
 * `client.createSession(...)` together with a TTL timer that auto-destroys
 * the session after `COPILOT_NATIVE_SESSION_TTL_MS` of inactivity (default
 * 30 min — matches the wrapper's existing per-session COPILOT_HOME lifetime
 * in the main server).
 *
 * Why this is in-memory: the sidecar is a single-process service and the
 * underlying `CopilotSession` is itself a live in-process object (event
 * emitter + open SSE stream against api.githubcopilot.com). Persisting the
 * map across restarts would not survive the connection re-handshake anyway.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventHandler = (event: any) => void;

/**
 * Subset of the `@github/copilot-sdk` `CopilotSession` surface that the
 * sidecar relies on. Mirrors `CopilotSessionLike` in the main server's
 * `copilot-wrapper.ts` so the contract stays in lock-step.
 *
 * Half of that is now enforced rather than asserted: `scripts/lib/copilot-sdk-pin-core.mjs`
 * fails CI if this package and `server/` stop pinning the same SDK version, which they had
 * already silently done (`^0.2.2` here vs `^0.3.0` there, both resolved — #1347). The other
 * half — that this interface and `CopilotSessionLike` stay structurally identical — is
 * still only this comment; there is no artefact to compare, and neither `tsc` nor the unit
 * tests can see a divergence because both sides are hand-written structural types that
 * every test stubs (#1121).
 */
export interface CopilotSession {
  readonly sessionId: string;
  on?: (event: string, handler: EventHandler) => () => void;
  send?: (input: { prompt: string }) => Promise<unknown>;
  sendAndWait?: (input: { prompt: string }, timeoutMs?: number) => Promise<unknown>;
  destroy?: () => Promise<void>;
  disconnect?: () => Promise<void>;
}

interface SessionEntry {
  session: CopilotSession;
  timer: NodeJS.Timeout;
  /** Optional caller-supplied directory the sidecar should `rm -rf` on cleanup. */
  copilotHome?: string;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

function readTtlMs(): number {
  const raw = process.env.COPILOT_NATIVE_SESSION_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_MS;
  return n;
}

export class SessionRegistry {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs?: number) {
    this.ttlMs = ttlMs ?? readTtlMs();
  }

  /**
   * Insert a session and arm a TTL. Replaces an existing entry with the
   * same id — the previous timer is cleared so we don't double-destroy.
   */
  set(session: CopilotSession, copilotHome?: string): void {
    const existing = this.entries.get(session.sessionId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      void this.destroy(session.sessionId).catch(() => {
        /* swallow — TTL cleanup is best-effort */
      });
    }, this.ttlMs);
    // Don't keep the event loop alive purely for an idle timer.
    timer.unref?.();
    this.entries.set(session.sessionId, { session, timer, copilotHome });
  }

  get(sessionId: string): CopilotSession | undefined {
    return this.entries.get(sessionId)?.session;
  }

  /**
   * Sliding TTL — every `send` / `send-and-wait` resets the deadline so an
   * active session does not get reaped mid-conversation.
   */
  touch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    const timer = setTimeout(() => {
      void this.destroy(sessionId).catch(() => {
        /* ignore */
      });
    }, this.ttlMs);
    timer.unref?.();
    entry.timer = timer;
  }

  async destroy(sessionId: string): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(sessionId);
    try {
      if (entry.session.destroy) await entry.session.destroy();
      else if (entry.session.disconnect) await entry.session.disconnect();
    } catch {
      /* best-effort */
    }
    return true;
  }

  /** Test helper — drop every session without invoking destroy(). */
  clear(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  ttl(): number {
    return this.ttlMs;
  }
}
