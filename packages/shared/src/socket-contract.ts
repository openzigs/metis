/**
 * Realtime contract hygiene — typed-event drift guard (#417, Epic #405).
 *
 * Pure, filesystem-free helpers that statically reconcile the Socket.IO
 * `ServerToClientEvents` contract (declared in `socket.ts`) against the events
 * the server actually emits and the events the UI actually consumes.
 *
 * The CI test (`tests/socket-contract.test.ts`) reads the real source files,
 * extracts the three sets (declared / emitted / consumed), and feeds them into
 * {@link findDriftedEvents}. A declared event that is neither emitted nor
 * consumed nor explicitly allow-listed is reported as "drifted" and fails CI,
 * keeping the contract honest as the app evolves.
 *
 * All functions here are intentionally side-effect-free so they can be unit
 * tested against in-memory fixtures (including a synthetic drifted event) with
 * no filesystem access.
 */

/**
 * Explicit allow-list of declared `ServerToClientEvents` that legitimately have
 * no UI `.on(...)` consumer. Each entry MUST carry a reason so the exception is
 * self-documenting and reviewable.
 *
 * Two categories:
 *  - **protocol/handshake/admin** events with no React consumer by design; and
 *  - **#406-deferred** events whose server emitter already exists but whose
 *    progress UI is owned by Epic #406 (progress feedback). These must NOT be
 *    deleted — removing the contract entry would break the live emitter and
 *    fail typecheck.
 */
export const SOCKET_EVENT_ALLOWLIST: Readonly<Record<string, string>> = {
  // --- Protocol / handshake / admin — no React consumer by design ----------
  "auth:ok": "Handshake ack consumed by the low-level socket client, not a React .on() listener.",
  "auth:error": "Handshake error; surfaced by socket-client.ts plumbing, not a feature component.",
  heartbeat: "Keep-alive ping; the client library handles it, no UI renders it.",
  "mcp:status": "MCP admin/protocol channel; no end-user React consumer by design.",
  "mcp:approval:requested":
    "MCP approval protocol; gated to admin/session plumbing, no UI consumer yet.",
  "mcp:approval:decided":
    "MCP approval protocol; gated to admin/session plumbing, no UI consumer yet.",
  // --- Deferred to Epic #406 (progress feedback) — emitter exists, UI later -
  "usage:tick":
    "TODO(#406): wire progress UI consumer — FinOps per-call tick emitter already live.",
  "bg-run:status":
    "TODO(#406): wire progress UI consumer — background-run status emitter already live.",
  "bg-run:step":
    "TODO(#406): wire progress UI consumer — background-run step emitter already live.",
  "document:status": "TODO(#406): wire progress UI consumer — RAG doc-status emitter already live.",
  "connector:status":
    "TODO(#406): wire progress UI consumer — connector status emitter already live.",
  "presence:error":
    "TODO(#406): wire progress UI consumer — presence room-cap error emitter already live.",
};

/** Inputs to the pure drift checker. */
export interface DriftCheckInput {
  /** Event names declared on `ServerToClientEvents`. */
  declaredEvents: readonly string[];
  /** Event names found as `.emit("<event>")` in the server source. */
  emitters: readonly string[];
  /** Event names found as `.on("<event>")` in the UI source. */
  consumers: readonly string[];
  /** Allow-listed event names (keys of {@link SOCKET_EVENT_ALLOWLIST}). */
  allowlist: readonly string[];
}

/**
 * Core, pure drift check. Returns the sorted list of declared events that are
 * **drifted**: neither emitted by the server, nor consumed by the UI, nor
 * present on the allow-list. An empty result means the contract is honest.
 */
export function findDriftedEvents(input: DriftCheckInput): string[] {
  const emitted = new Set(input.emitters);
  const consumed = new Set(input.consumers);
  const allowed = new Set(input.allowlist);

  const drifted = input.declaredEvents.filter(
    (event) => !emitted.has(event) && !consumed.has(event) && !allowed.has(event),
  );

  return [...new Set(drifted)].sort();
}

/**
 * Report allow-list entries that no longer correspond to a declared event.
 * Keeps the allow-list from rotting once an event is removed/renamed — a stale
 * entry would silently mask a future re-introduction of the same name.
 */
export function findStaleAllowlistEntries(
  declaredEvents: readonly string[],
  allowlist: readonly string[],
): string[] {
  const declared = new Set(declaredEvents);
  return [...new Set(allowlist.filter((event) => !declared.has(event)))].sort();
}

/**
 * Extract the event names declared on the `ServerToClientEvents` interface from
 * the raw text of `socket.ts`. We isolate the interface body by brace matching
 * (the body itself contains nested `{ ... }` payload shapes) and then pull each
 * top-level member key, which may be a quoted string (`"job:lifecycle"`) or a
 * bare identifier (`heartbeat`).
 */
export function parseDeclaredEvents(socketSource: string): string[] {
  const marker = "interface ServerToClientEvents";
  const start = socketSource.indexOf(marker);
  if (start === -1) {
    throw new Error("Could not locate `interface ServerToClientEvents` in socket source.");
  }
  const open = socketSource.indexOf("{", start);
  if (open === -1) {
    throw new Error("Malformed `ServerToClientEvents` interface — no opening brace.");
  }

  // Brace-match to find the matching close of the interface body.
  let depth = 0;
  let end = -1;
  for (let i = open; i < socketSource.length; i++) {
    const ch = socketSource[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error("Malformed `ServerToClientEvents` interface — unbalanced braces.");
  }

  const body = socketSource.slice(open + 1, end);
  const events = new Set<string>();

  // A member key sits at brace-depth 1 (top level of the interface body) and is
  // immediately followed by `:` and a function-typed value. Walk the body and
  // capture keys only when depth === 0 relative to the body slice.
  let bodyDepth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{") bodyDepth++;
    else if (ch === "}") bodyDepth--;
    if (bodyDepth !== 0) continue;

    // Quoted member key: "event:name": (...) => void
    if (ch === '"') {
      const close = body.indexOf('"', i + 1);
      if (close !== -1) {
        const key = body.slice(i + 1, close);
        // Confirm it's a member (next non-space char is `:`), not a string in a comment.
        const after = body.slice(close + 1).match(/^\s*:/);
        if (after) events.add(key);
        i = close;
      }
    }
  }

  // Bare-identifier member keys (e.g. `heartbeat: (...) => void`) at depth 1.
  // Match identifiers that are directly followed by `:` and an arrow function.
  for (const m of body.matchAll(/(^|[\n;{}])\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*\(/g)) {
    events.add(m[2]);
  }

  return [...events].sort();
}

/**
 * Extract every event name passed as a string literal to `.emit("<event>", …)`
 * from a blob of server source. Computed/templated emit names (e.g. a ternary
 * that selects between two literals) are still captured because both literals
 * appear elsewhere as string tokens, but the canonical case is a direct literal.
 */
export function extractEmittedEvents(serverSource: string): string[] {
  return extractEventLiterals(serverSource, /\.emit\(\s*"([^"]+)"/g);
}

/**
 * Extract every event name passed as a string literal to `.on("<event>", …)`
 * from a blob of UI source.
 */
export function extractConsumedEvents(uiSource: string): string[] {
  return extractEventLiterals(uiSource, /\.on\(\s*"([^"]+)"/g);
}

function extractEventLiterals(source: string, pattern: RegExp): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(pattern)) {
    found.add(m[1]);
  }
  return [...found].sort();
}
