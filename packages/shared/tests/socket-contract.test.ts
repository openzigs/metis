/**
 * Realtime contract hygiene + typed-event drift guard (#417, Epic #405).
 *
 * Two layers of assurance:
 *
 *  1. **Pure-logic unit tests** exercise the drift checker and the source
 *     parsers against in-memory fixtures — including a SYNTHETIC drifted event
 *     that is neither emitted, consumed, nor allow-listed — proving the guard
 *     actually catches drift (not just that the current repo happens to pass).
 *
 *  2. **The live CI guard** scans the real `socket.ts`, `server/src`, and
 *     `ui/src`, then asserts every declared `ServerToClientEvents` member is
 *     emitted AND consumed (or allow-listed as consumer-less), and has a row in
 *     the `docs/ARCHITECTURE.md` §7.6.4 realtime event catalogue (#91).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SOCKET_COMPUTED_EMITTERS,
  SOCKET_EVENT_ALLOWLIST,
  checkSocketContract,
  extractConsumedEvents,
  extractEmittedEvents,
  findStaleAllowlistEntries,
  findStaleCatalogueRows,
  findUncataloguedEvents,
  parseDeclaredEvents,
  parseEventCatalogue,
} from "../src/socket-contract.js";

// ---------------------------------------------------------------------------
// Layer 1 — pure-logic unit tests (no filesystem)
// ---------------------------------------------------------------------------

const EMPTY_REPORT = { neverEmitted: [], unconsumed: [], redundantAllowlist: [] };

describe("checkSocketContract (pure, two-sided — #91)", () => {
  it("returns an empty report when every event is emitted and consumed or allow-listed", () => {
    expect(
      checkSocketContract({
        declaredEvents: ["job:lifecycle", "auth:ok", "comment:mention"],
        emitters: ["job:lifecycle", "auth:ok", "comment:mention"],
        consumers: ["job:lifecycle", "comment:mention"],
        allowlist: ["auth:ok"],
      }),
    ).toEqual(EMPTY_REPORT);
  });

  it("FAILS on a misspelled CONSUMER — the event is emitted, the listener name is wrong", () => {
    // The #91 shape: the old one-sided rule saw `drift:detected` emitted and
    // stopped there, so this passed CI.
    const report = checkSocketContract({
      declaredEvents: ["drift:detected"],
      emitters: ["drift:detected"],
      consumers: ["drift:detectd"],
      allowlist: [],
    });
    expect(report.unconsumed).toEqual(["drift:detected"]);
  });

  it("FAILS on a misspelled EMITTER — the event is consumed, the server emits a different name", () => {
    const report = checkSocketContract({
      declaredEvents: ["drift:detected"],
      emitters: ["drift:detectd"],
      consumers: ["drift:detected"],
      allowlist: [],
    });
    expect(report.neverEmitted).toEqual(["drift:detected"]);
  });

  it("FAILS on an event used on neither side (the original #417 case)", () => {
    const report = checkSocketContract({
      declaredEvents: ["job:lifecycle", "fake:orphan"],
      emitters: ["job:lifecycle"],
      consumers: ["job:lifecycle"],
      allowlist: [],
    });
    expect(report.neverEmitted).toEqual(["fake:orphan"]);
  });

  it("an allow-list entry excuses a missing consumer, never a missing emitter", () => {
    const report = checkSocketContract({
      declaredEvents: ["usage:tick", "mcp:status"],
      emitters: ["usage:tick"],
      consumers: [],
      allowlist: ["usage:tick", "mcp:status"],
    });
    expect(report).toEqual({ ...EMPTY_REPORT, neverEmitted: ["mcp:status"] });
  });

  it("flags an allow-list entry for an event that IS consumed", () => {
    const report = checkSocketContract({
      declaredEvents: ["document:status"],
      emitters: ["document:status"],
      consumers: ["document:status"],
      allowlist: ["document:status"],
    });
    expect(report.redundantAllowlist).toEqual(["document:status"]);
  });

  it("reports de-duplicated, sorted lists", () => {
    const report = checkSocketContract({
      declaredEvents: ["z:e", "a:e", "z:e", "ok:e"],
      emitters: ["z:e", "a:e", "ok:e"],
      consumers: ["ok:e"],
      allowlist: [],
    });
    expect(report.unconsumed).toEqual(["a:e", "z:e"]);
  });
});

describe("parseEventCatalogue / findUncataloguedEvents / findStaleCatalogueRows", () => {
  const doc = [
    "#### 7.6.3 Something else",
    "| Event | x |",
    "| `not:this:section` | y |",
    "#### 7.6.4 Realtime event catalogue",
    "",
    "| Event | Emitter | UI consumer | Status |",
    "|---|---|---|---|",
    "| `job:lifecycle` | a | b | live |",
    "| `publish:status` / `publish:progress` | a | b | live |",
    "| `requirement:drift` | — | — | **removed** (#417), superseded by `drift:detected` |",
    "",
    "### 7.7 Next section",
    "| `after:section` | a | b | live |",
  ].join("\n");

  it("reads only the §7.6.4 table, splitting multi-event rows and removed rows", () => {
    expect(parseEventCatalogue(doc)).toEqual({
      current: ["job:lifecycle", "publish:progress", "publish:status"],
      removed: ["requirement:drift"],
    });
  });

  it("flags a declared event with no row — and one that has only a REMOVED row", () => {
    const cat = parseEventCatalogue(doc);
    expect(
      findUncataloguedEvents(["job:lifecycle", "drift:detected", "requirement:drift"], cat),
    ).toEqual(["drift:detected", "requirement:drift"]);
  });

  it("flags a current row naming an undeclared event", () => {
    const cat = parseEventCatalogue(doc);
    expect(findStaleCatalogueRows(["job:lifecycle", "publish:status"], cat)).toEqual([
      "publish:progress",
    ]);
  });

  it("throws when the heading or its rows are missing, rather than passing vacuously", () => {
    expect(() => parseEventCatalogue("# nothing here")).toThrow(/7\.6\.4/);
    expect(() => parseEventCatalogue("#### 7.6.4 Catalogue\n\nno table\n")).toThrow(
      /no event rows/,
    );
  });
});

describe("findStaleAllowlistEntries", () => {
  it("flags allow-list entries that no longer correspond to a declared event", () => {
    expect(
      findStaleAllowlistEntries(["job:lifecycle", "auth:ok"], ["auth:ok", "ghost:event"]),
    ).toEqual(["ghost:event"]);
  });

  it("returns nothing when every allow-list entry is still declared", () => {
    expect(findStaleAllowlistEntries(["auth:ok", "heartbeat"], ["auth:ok"])).toEqual([]);
  });
});

describe("parseDeclaredEvents", () => {
  const fixture = `
    export interface ServerToClientEvents {
      "job:lifecycle": (data: JobLifecycleEvent) => void;
      "auth:ok": (data: { userId: string; username: string }) => void;
      "document:status": (data: {
        projectId: string;
        // a quoted "status:like" token inside a payload must NOT be captured
        status: "pending" | "ready";
      }) => void;
      heartbeat: (data: { ts: number }) => void;
    }
    export interface OtherThing {
      "should:not:capture": () => void;
    }
  `;

  it("extracts quoted and bare member keys, ignoring nested payload tokens", () => {
    const events = parseDeclaredEvents(fixture);
    expect(events).toEqual(["auth:ok", "document:status", "heartbeat", "job:lifecycle"]);
    expect(events).not.toContain("status:like");
    expect(events).not.toContain("should:not:capture");
  });

  it("throws when the interface is absent", () => {
    expect(() => parseDeclaredEvents("export const x = 1;")).toThrow(/ServerToClientEvents/);
  });
});

describe("extractEmittedEvents / extractConsumedEvents", () => {
  it("pulls .emit('<event>') string literals", () => {
    const src = `
      io.to(room).emit("job:lifecycle", data);
      socket.emit("auth:ok", { userId });
      io.emit( "heartbeat" , { ts });
    `;
    expect(extractEmittedEvents(src)).toEqual(["auth:ok", "heartbeat", "job:lifecycle"]);
  });

  it("pulls .on('<event>') string literals", () => {
    const src = `
      socket.on("comment:mention", onMention);
      socket.on( "task:status", onStatus);
    `;
    expect(extractConsumedEvents(src)).toEqual(["comment:mention", "task:status"]);
  });

  it("returns an empty list when there are no matches", () => {
    expect(extractEmittedEvents("const x = 1;")).toEqual([]);
    expect(extractConsumedEvents("const x = 1;")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — live CI guard (scans the real repo)
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
// packages/shared/tests -> repo root
const repoRoot = resolve(here, "..", "..", "..");
const socketTsPath = join(repoRoot, "packages", "shared", "src", "socket.ts");

/** Recursively read every .ts/.tsx file under `dir` into one concatenated blob. */
function readSourceTree(dir: string): string {
  let blob = "";
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      blob += readSourceTree(full);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      blob += readFileSync(full, "utf8") + "\n";
    }
  }
  return blob;
}

describe("realtime contract guard (live repo scan)", () => {
  const socketSource = readFileSync(socketTsPath, "utf8");
  const declaredEvents = parseDeclaredEvents(socketSource);
  const serverSrc = join(repoRoot, "server", "src");
  const computedEmitters = Object.entries(SOCKET_COMPUTED_EMITTERS)
    .filter(([event, file]) => readFileSync(join(serverSrc, file), "utf8").includes(`"${event}"`))
    .map(([event]) => event);
  const serverEmitters = [...extractEmittedEvents(readSourceTree(serverSrc)), ...computedEmitters];
  const uiConsumers = extractConsumedEvents(readSourceTree(join(repoRoot, "ui", "src")));
  const allowlist = Object.keys(SOCKET_EVENT_ALLOWLIST);
  const catalogue = parseEventCatalogue(
    readFileSync(join(repoRoot, "docs", "ARCHITECTURE.md"), "utf8"),
  );

  it("declares at least the known core events (sanity that parsing worked)", () => {
    expect(declaredEvents.length).toBeGreaterThan(10);
    expect(declaredEvents).toContain("job:lifecycle");
    expect(declaredEvents).toContain("heartbeat");
  });

  it("every computed emitter's literal is still in its named server file", () => {
    expect(computedEmitters.sort()).toEqual(Object.keys(SOCKET_COMPUTED_EMITTERS).sort());
  });

  it("every declared event is emitted AND consumed, or allow-listed as consumer-less (#91)", () => {
    const report = checkSocketContract({
      declaredEvents,
      emitters: serverEmitters,
      consumers: uiConsumers,
      allowlist,
    });
    expect(
      report,
      `ServerToClientEvents out of step with server/src emitters and ui/src consumers. ` +
        `neverEmitted: nothing in server/src emits it (misspelled emitter, or a computed name ` +
        `missing from SOCKET_COMPUTED_EMITTERS). unconsumed: no ui/src .on() listener ` +
        `(misspelled listener?) — wire one or add a SOCKET_EVENT_ALLOWLIST reason. ` +
        `redundantAllowlist: the event IS consumed; delete its allow-list entry.`,
    ).toEqual(EMPTY_REPORT);
  });

  it("every declared event has a current row in the ARCHITECTURE.md §7.6.4 catalogue (#91)", () => {
    const missing = findUncataloguedEvents(declaredEvents, catalogue);
    expect(
      missing,
      `Declared events with no current row in docs/ARCHITECTURE.md §7.6.4: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("no current §7.6.4 row names an event that is not declared (#91)", () => {
    const stale = findStaleCatalogueRows(declaredEvents, catalogue);
    expect(
      stale,
      `§7.6.4 rows imply these events exist, but socket.ts does not declare them: ` +
        `${stale.join(", ")}. Mark the row **removed** or delete it.`,
    ).toEqual([]);
  });

  it("removed `requirement:drift` is fully gone from the contract and catalogued as removed", () => {
    expect(declaredEvents).not.toContain("requirement:drift");
    expect(catalogue.removed).toContain("requirement:drift");
    expect(catalogue.current).toContain("drift:detected");
  });

  it("has no stale allow-list entries (each allow-listed event is still declared)", () => {
    const stale = findStaleAllowlistEntries(declaredEvents, allowlist);
    expect(stale, `Stale allow-list entries (no longer declared): ${stale.join(", ")}`).toEqual([]);
  });

  it("every allow-list entry carries a non-empty documented reason", () => {
    for (const [event, reason] of Object.entries(SOCKET_EVENT_ALLOWLIST)) {
      expect(reason.trim().length, `allow-list entry "${event}" needs a reason`).toBeGreaterThan(0);
    }
  });
});
