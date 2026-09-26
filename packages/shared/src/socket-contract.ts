/**
 * Realtime contract hygiene — typed-event drift guard (#417, Epic #405).
 *
 * Pure, filesystem-free helpers that statically reconcile the Socket.IO
 * `ServerToClientEvents` contract (declared in `socket.ts`) against the events
 * the server actually emits and the events the UI actually consumes.
 *
 * The CI test (`tests/socket-contract.test.ts`) reads the real source files,
 * extracts the three sets (declared / emitted / consumed), and feeds them into
 * {@link checkSocketContract}. Since #91 the check is TWO-SIDED: a declared
 * event must be emitted by the server AND consumed by the UI (or carry an
 * allow-list reason for having no consumer). The earlier rule failed only when
 * an event was used on NEITHER side, so an emitted event whose UI listener name
 * was misspelled passed CI — the declaration was "used" by the emitter alone.
 * {@link findUncataloguedEvents} additionally pins every declared event to a
 * row of the `docs/ARCHITECTURE.md` §7.6.4 realtime event catalogue.
 *
 * All functions here are intentionally side-effect-free so they can be unit
 * tested against in-memory fixtures (including a synthetic drifted event) with
 * no filesystem access.
 */

/**
 * Explicit allow-list of declared `ServerToClientEvents` that are emitted but
 * legitimately have no UI `.on(...)` consumer. Each entry MUST carry a reason so
 * the exception is self-documenting and reviewable. An entry for an event that
 * IS consumed fails the guard (`redundantAllowlist`): the exception would
 * otherwise outlive its reason and hide a later consumer-side misspelling.
 *
 * Categories:
 *  - **protocol/handshake/admin** events with no React consumer by design;
 *  - **#406-deferred** events whose server emitter already exists but whose
 *    progress UI is owned by Epic #406 (progress feedback). These must NOT be
 *    deleted — removing the contract entry would break the live emitter and
 *    fail typecheck; and
 *  - **found by #91** — emitted events that had no UI consumer, invisible to
 *    the old one-sided rule. Recorded here, not wired, so the guard can go
 *    green without inventing UI; each names what the UI uses instead.
 */
export const SOCKET_EVENT_ALLOWLIST: Readonly<Record<string, string>> = {
  // --- Protocol / handshake / admin — no React consumer by design ----------
  "auth:ok": "Handshake ack consumed by the low-level socket client, not a React .on() listener.",
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
  "connector:status":
    "TODO(#406): wire progress UI consumer — connector status emitter already live.",
  "presence:error":
    "TODO(#406): wire progress UI consumer — presence room-cap error emitter already live.",
  // --- Found by #91's two-sided rule — emitted, never consumed in ui/src ----
  "analysis:agent":
    "#91: analysis:{id} room event with no ui/src listener; the UI follows analysis runs via job:lifecycle.",
  "analysis:capability":
    "#91: analysis:{id} room event with no ui/src listener; the UI follows analysis runs via job:lifecycle.",
  "analysis:repos-skipped":
    "#91: analysis:{id} room event with no ui/src listener; the UI follows analysis runs via job:lifecycle.",
  "analysis:completed":
    "#91: analysis:{id} room event with no ui/src listener; the UI follows analysis runs via job:lifecycle.",
  "analysis:failed":
    "#91: analysis:{id} room event with no ui/src listener; the UI follows analysis runs via job:lifecycle.",
  "analysis:cancelled":
    "#91: analysis:{id} room event with no ui/src listener; the UI follows analysis runs via job:lifecycle.",
  "discussion:mention":
    "TODO(#104): user:{id} notification with no ui/src listener; the drawer listens to comment:mention only.",
  "review:notification":
    "TODO(#104): user:{id} notification with no ui/src listener; nothing renders it in realtime.",
};

/**
 * Declared events whose server emitter computes the event NAME (so no
 * `.emit("<literal>")` exists for {@link extractEmittedEvents} to find), mapped
 * to the server file, relative to `server/src`, that holds the literal. The
 * live guard counts such an event as emitted only if that file still contains
 * the quoted name — a rename on the server side still fails.
 */
export const SOCKET_COMPUTED_EMITTERS: Readonly<Record<string, string>> = {
  "testcoverage:run-update": "lib/testcoverage/socket-emitter.ts",
  "testcoverage:run-finished": "lib/testcoverage/socket-emitter.ts",
};

/**
 * #113 — `.emit("<literal>")` names in `server/src` that are NOT Socket.IO
 * events: other Node `EventEmitter`s share the call shape. Each entry needs a
 * reason; an entry no longer emitted fails the guard (`staleNonSocketEmits`), so
 * it cannot outlive its reason and later excuse a misspelling of the same name.
 */
export const SOCKET_NON_SOCKET_EMITS: Readonly<Record<string, string>> = {
  "config.changed":
    "ConfigService is a Node EventEmitter; in-process subscribers rebuild on a config write.",
  sessionStart: "Async runner hook bus (getHookBus()), not a socket.",
  sessionEnd: "Async runner hook bus (getHookBus()), not a socket.",
};

/**
 * #113 — listener names `ui/src` may use that are not `ServerToClientEvents`:
 * Socket.IO's own socket/manager lifecycle events, and `name`, the placeholder
 * in the hooks' doc comments describing the `socket.on("name" as never, …)`
 * escape hatch (the extractor reads comments too).
 */
export function isReservedListenName(name: string): boolean {
  return (
    name === "connect" ||
    name === "connect_error" ||
    name === "disconnect" ||
    name === "name" ||
    /^reconnect(_[a-z]+)?$/.test(name)
  );
}

/** Inputs to {@link findUndeclaredEventNames}. */
export interface EventNameCheckInput {
  declaredEvents: readonly string[];
  emitters: readonly string[];
  consumers: readonly string[];
  /** Keys of {@link SOCKET_NON_SOCKET_EMITS}. */
  nonSocketEmits: readonly string[];
}

/** Names used in code that the contract does not declare. */
export interface EventNameReport {
  /** Emitted names that are neither declared nor a listed non-socket emit. */
  undeclaredEmits: string[];
  /** Listened-for names that are neither declared nor a Socket.IO reserved name. */
  undeclaredListens: string[];
  /** Listed non-socket emits that nothing emits any more. */
  staleNonSocketEmits: string[];
}

/**
 * #113 — the name-side half of the contract. {@link checkSocketContract} walks
 * the DECLARED events, so a misspelled copy (`drift:detectd` beside a correct
 * `drift:detected`) never fails it: the declared event is satisfied by the
 * correct occurrence and the typo is never looked at. This walks every USED
 * name instead.
 */
export function findUndeclaredEventNames(input: EventNameCheckInput): EventNameReport {
  const declared = new Set(input.declaredEvents);
  const nonSocket = new Set(input.nonSocketEmits);
  const emitted = new Set(input.emitters);
  return {
    undeclaredEmits: sortedUnique(input.emitters).filter(
      (e) => !declared.has(e) && !nonSocket.has(e),
    ),
    undeclaredListens: sortedUnique(input.consumers).filter(
      (e) => !declared.has(e) && !isReservedListenName(e),
    ),
    staleNonSocketEmits: sortedUnique(input.nonSocketEmits).filter((e) => !emitted.has(e)),
  };
}

/** Inputs to the pure contract checker. */
export interface DriftCheckInput {
  /** Event names declared on `ServerToClientEvents`. */
  declaredEvents: readonly string[];
  /** Event names the server emits (literal `.emit("<event>")` + computed emitters). */
  emitters: readonly string[];
  /** Event names found as `.on("<event>")` in the UI source. */
  consumers: readonly string[];
  /** Allow-listed event names (keys of {@link SOCKET_EVENT_ALLOWLIST}). */
  allowlist: readonly string[];
}

/** Every way a declared event can disagree with its emitter and consumer. */
export interface SocketContractReport {
  /** Declared but never emitted — a consumer (if any) listens for nothing. */
  neverEmitted: string[];
  /** Emitted but no UI consumer and no allow-list reason — e.g. a misspelled listener. */
  unconsumed: string[];
  /** Allow-listed as having no consumer, yet one exists. */
  redundantAllowlist: string[];
}

const sortedUnique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/**
 * Core, pure, TWO-SIDED contract check (#91). Each declared event must be
 * emitted, and must be consumed unless allow-listed. All arrays are sorted and
 * de-duplicated; an all-empty report means the contract is honest.
 */
export function checkSocketContract(input: DriftCheckInput): SocketContractReport {
  const emitted = new Set(input.emitters);
  const consumed = new Set(input.consumers);
  const allowed = new Set(input.allowlist);
  const declared = sortedUnique(input.declaredEvents);

  return {
    neverEmitted: declared.filter((e) => !emitted.has(e)),
    unconsumed: declared.filter((e) => emitted.has(e) && !consumed.has(e) && !allowed.has(e)),
    redundantAllowlist: declared.filter((e) => allowed.has(e) && consumed.has(e)),
  };
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
 * from a blob of server source. A computed emit name (e.g. a ternary selecting
 * between two literals) is NOT captured — declare it in
 * {@link SOCKET_COMPUTED_EMITTERS} instead.
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

/** The §7.6.4 realtime event catalogue, as parsed from `docs/ARCHITECTURE.md`. */
export interface EventCatalogue {
  /** Events on a row whose status does not say **removed**. */
  current: string[];
  /** Events on a row whose status says **removed**. */
  removed: string[];
}

const CATALOGUE_HEADING = /^#{2,6}\s+7\.6\.4\b/;

/**
 * Parse the §7.6.4 catalogue table out of `docs/ARCHITECTURE.md`. The first
 * cell of a row may name several events as backticked literals separated by
 * `/`; the last cell is the status, and a status containing `removed` marks a
 * historical row rather than a current event.
 */
export function parseEventCatalogue(markdown: string): EventCatalogue {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => CATALOGUE_HEADING.test(l));
  if (start === -1) {
    throw new Error("Could not locate the §7.6.4 realtime event catalogue heading.");
  }
  const current = new Set<string>();
  const removed = new Set<string>();
  let rows = 0;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2 || /^-+$/.test(cells[0]) || cells[0] === "Event") continue;
    const names = [...cells[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (names.length === 0) continue;
    rows++;
    const target = /\bremoved\b/i.test(cells[cells.length - 1]) ? removed : current;
    for (const n of names) target.add(n);
  }
  if (rows === 0) throw new Error("The §7.6.4 realtime event catalogue has no event rows.");
  return { current: [...current].sort(), removed: [...removed].sort() };
}

/** Declared events with no current §7.6.4 row (a **removed** row does not count). */
export function findUncataloguedEvents(
  declaredEvents: readonly string[],
  catalogue: EventCatalogue,
): string[] {
  const listed = new Set(catalogue.current);
  return sortedUnique(declaredEvents).filter((e) => !listed.has(e));
}

/** Current §7.6.4 rows naming an event that is not declared — the doc implies it exists. */
export function findStaleCatalogueRows(
  declaredEvents: readonly string[],
  catalogue: EventCatalogue,
): string[] {
  const declared = new Set(declaredEvents);
  return catalogue.current.filter((e) => !declared.has(e));
}
