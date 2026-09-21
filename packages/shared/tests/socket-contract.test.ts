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
 *     `ui/src`, then asserts no declared `ServerToClientEvents` member has
 *     drifted away from both its emitter and its consumer.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SOCKET_EVENT_ALLOWLIST,
  extractConsumedEvents,
  extractEmittedEvents,
  findDriftedEvents,
  findStaleAllowlistEntries,
  parseDeclaredEvents,
} from "../src/socket-contract.js";

// ---------------------------------------------------------------------------
// Layer 1 — pure-logic unit tests (no filesystem)
// ---------------------------------------------------------------------------

describe("findDriftedEvents (pure drift checker)", () => {
  it("returns nothing when every event is emitted, consumed, or allow-listed", () => {
    const drifted = findDriftedEvents({
      declaredEvents: ["job:lifecycle", "auth:ok", "comment:mention"],
      emitters: ["job:lifecycle"],
      consumers: ["comment:mention"],
      allowlist: ["auth:ok"],
    });
    expect(drifted).toEqual([]);
  });

  it("FAILS on a synthetic drifted event that is neither emitted, consumed, nor allow-listed", () => {
    // `fake:orphan` is a deliberately drifted ServerToClientEvents-style member.
    const drifted = findDriftedEvents({
      declaredEvents: ["job:lifecycle", "fake:orphan"],
      emitters: ["job:lifecycle"],
      consumers: [],
      allowlist: [],
    });
    expect(drifted).toEqual(["fake:orphan"]);
    expect(drifted).toContain("fake:orphan");
  });

  it("treats an emitter-only event as honest (no UI consumer required)", () => {
    expect(
      findDriftedEvents({
        declaredEvents: ["usage:tick"],
        emitters: ["usage:tick"],
        consumers: [],
        allowlist: [],
      }),
    ).toEqual([]);
  });

  it("treats a consumer-only event as honest (computed/templated emit names)", () => {
    expect(
      findDriftedEvents({
        declaredEvents: ["testcoverage:run-update"],
        emitters: [],
        consumers: ["testcoverage:run-update"],
        allowlist: [],
      }),
    ).toEqual([]);
  });

  it("treats an allow-listed event with no emitter and no consumer as honest", () => {
    expect(
      findDriftedEvents({
        declaredEvents: ["mcp:status"],
        emitters: [],
        consumers: [],
        allowlist: ["mcp:status"],
      }),
    ).toEqual([]);
  });

  it("reports multiple drifted events, de-duplicated and sorted", () => {
    expect(
      findDriftedEvents({
        declaredEvents: ["z:orphan", "a:orphan", "z:orphan", "ok:event"],
        emitters: ["ok:event"],
        consumers: [],
        allowlist: [],
      }),
    ).toEqual(["a:orphan", "z:orphan"]);
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
  const serverEmitters = extractEmittedEvents(readSourceTree(join(repoRoot, "server", "src")));
  const uiConsumers = extractConsumedEvents(readSourceTree(join(repoRoot, "ui", "src")));
  const allowlist = Object.keys(SOCKET_EVENT_ALLOWLIST);

  it("declares at least the known core events (sanity that parsing worked)", () => {
    expect(declaredEvents.length).toBeGreaterThan(10);
    expect(declaredEvents).toContain("job:lifecycle");
    expect(declaredEvents).toContain("heartbeat");
  });

  it("has no drifted events — every declared event is emitted, consumed, or allow-listed", () => {
    const drifted = findDriftedEvents({
      declaredEvents,
      emitters: serverEmitters,
      consumers: uiConsumers,
      allowlist,
    });
    expect(
      drifted,
      `Drifted ServerToClientEvents (declared but neither emitted in server/src, ` +
        `consumed in ui/src, nor allow-listed in SOCKET_EVENT_ALLOWLIST): ${drifted.join(", ")}. ` +
        `Either wire an emitter/consumer or add an allow-list entry with a reason.`,
    ).toEqual([]);
  });

  it("removed `requirement:drift` is fully gone from the contract", () => {
    expect(declaredEvents).not.toContain("requirement:drift");
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
