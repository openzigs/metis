/**
 * #1414 — `session-disconnect.ts` without a real server: the cross-replica
 * relay of an ended session, its bounded memory, and the no-server no-op.
 * The real-socket behaviour is `socket-session-binding-1414.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({ io: null as unknown }));
vi.mock("../src/lib/socket/registry.js", () => ({
  getSocketServer: () => registry.io,
  registerSocketServer: (io: unknown) => (registry.io = io),
}));

import type { MetisIOServer } from "../src/lib/socket/server.js";
import {
  DISCONNECT_SESSION_EVENT,
  END_USER_SESSIONS_EVENT,
  MAX_ENDED_SESSIONS,
  __resetEndedSessionsForTests,
  authSessionRoom,
  disconnectSessionSockets,
  endUserSessionsIssuedBy,
  isSessionEnded,
  isTokenSessionEnded,
  wireSessionRevocationRelay,
} from "../src/lib/socket/session-disconnect.js";
import { accessTokenTtlSeconds } from "../src/lib/auth/jwt.js";

const SID = "01J00000000000000000000009";

/** Enough of a Socket.IO server for the relay: rooms, `local`, `on`, `serverSideEmit`. */
function fakeServer() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const disconnected: string[] = [];
  const localDisconnected: string[] = [];
  const emitted: unknown[][] = [];
  const server = {
    in: (room: string) => ({ disconnectSockets: () => void disconnected.push(room) }),
    local: {
      in: (room: string) => ({ disconnectSockets: () => void localDisconnected.push(room) }),
    },
    on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
    serverSideEmit: (...args: unknown[]) => void emitted.push(args),
  };
  return {
    io: server as unknown as MetisIOServer,
    listeners,
    disconnected,
    localDisconnected,
    emitted,
  };
}

beforeEach(() => {
  __resetEndedSessionsForTests();
  registry.io = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("#1414 disconnectSessionSockets", () => {
  it("is a no-op with no registered server", () => {
    disconnectSessionSockets("u", SID);
    expect(isSessionEnded("u", SID)).toBe(false);
  });

  it("disconnects the session's room, records it, and relays it on a clustered server", () => {
    const fake = fakeServer();
    wireSessionRevocationRelay(fake.io, true);
    registry.io = fake.io;

    disconnectSessionSockets("u", SID);
    disconnectSessionSockets("u", undefined);

    expect(fake.disconnected).toEqual([authSessionRoom("u", SID), authSessionRoom("u", undefined)]);
    expect(isSessionEnded("u", SID)).toBe(true);
    expect(isSessionEnded("u", undefined)).toBe(true);
    expect(isSessionEnded("other", SID)).toBe(false);
    expect(fake.emitted).toEqual([
      [DISCONNECT_SESSION_EVENT, "u", SID],
      [DISCONNECT_SESSION_EVENT, "u", "legacy"],
    ]);
  });

  it("does not relay on a single-replica server", () => {
    const fake = fakeServer();
    wireSessionRevocationRelay(fake.io, false);
    registry.io = fake.io;

    disconnectSessionSockets("u", SID);

    expect(fake.emitted).toEqual([]);
    expect(fake.listeners.size).toBe(0);
  });

  it("logs, never throws, when the adapter fails", () => {
    const fake = fakeServer();
    (fake.io as unknown as { in: () => never }).in = () => {
      throw new Error("adapter down");
    };
    registry.io = fake.io;

    expect(() => disconnectSessionSockets("u", SID)).not.toThrow();
    expect(isSessionEnded("u", SID)).toBe(true);
  });

  it("forgets an ended session once its access tokens have all expired", () => {
    vi.useFakeTimers();
    registry.io = fakeServer().io;
    disconnectSessionSockets("u", SID);
    vi.advanceTimersByTime(accessTokenTtlSeconds() * 1000 - 1);
    expect(isSessionEnded("u", SID)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isSessionEnded("u", SID)).toBe(false);
  });

  it(`remembers at most ${MAX_ENDED_SESSIONS} sessions, dropping the oldest`, () => {
    registry.io = fakeServer().io;
    for (let i = 0; i <= MAX_ENDED_SESSIONS; i++) disconnectSessionSockets(`u${i}`, SID);
    expect(isSessionEnded("u0", SID)).toBe(false);
    expect(isSessionEnded("u1", SID)).toBe(true);
    expect(isSessionEnded(`u${MAX_ENDED_SESSIONS}`, SID)).toBe(true);
  });
});

describe("#1414 wireSessionRevocationRelay", () => {
  it("records a relayed session and disconnects its local sockets", () => {
    const fake = fakeServer();
    wireSessionRevocationRelay(fake.io, true);

    fake.listeners.get(DISCONNECT_SESSION_EVENT)!("u", SID);
    fake.listeners.get(DISCONNECT_SESSION_EVENT)!("u", "legacy");

    expect(isSessionEnded("u", SID)).toBe(true);
    expect(isSessionEnded("u", undefined)).toBe(true);
    expect(fake.localDisconnected).toEqual([
      authSessionRoom("u", SID),
      authSessionRoom("u", undefined),
    ]);
  });

  it("ignores a relay with a missing or non-string argument", () => {
    const fake = fakeServer();
    wireSessionRevocationRelay(fake.io, true);

    fake.listeners.get(DISCONNECT_SESSION_EVENT)!("u");
    fake.listeners.get(DISCONNECT_SESSION_EVENT)!("u", 7);

    expect(fake.localDisconnected).toEqual([]);
  });
});

describe("#1414 endUserSessionsIssuedBy", () => {
  it("ends the user's tokens issued at or before the cutoff, and no later or other ones", () => {
    endUserSessionsIssuedBy("u", 1_000);
    expect(isTokenSessionEnded("u", SID, 999)).toBe(true);
    expect(isTokenSessionEnded("u", SID, 1_000)).toBe(true);
    expect(isTokenSessionEnded("u", undefined, 1_000)).toBe(true);
    expect(isTokenSessionEnded("u", SID, undefined)).toBe(true);
    expect(isTokenSessionEnded("u", SID, 1_001)).toBe(false);
    expect(isTokenSessionEnded("other", SID, 999)).toBe(false);
  });

  it("keeps the later of two cutoffs", () => {
    endUserSessionsIssuedBy("u", 2_000);
    endUserSessionsIssuedBy("u", 1_000);
    expect(isTokenSessionEnded("u", SID, 1_500)).toBe(true);
  });

  it("forgets the cutoff once the user's access tokens have all expired", () => {
    vi.useFakeTimers();
    endUserSessionsIssuedBy("u", 1_000);
    vi.advanceTimersByTime(accessTokenTtlSeconds() * 1000);
    expect(isTokenSessionEnded("u", SID, 999)).toBe(false);
  });

  it("relays the cutoff on a clustered server", () => {
    const fake = fakeServer();
    wireSessionRevocationRelay(fake.io, true);
    registry.io = fake.io;
    endUserSessionsIssuedBy("u", 1_000);
    expect(fake.emitted).toEqual([[END_USER_SESSIONS_EVENT, "u", "1000"]]);
  });

  it("applies a relayed cutoff, never later than now, and ignores a malformed one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const fake = fakeServer();
    wireSessionRevocationRelay(fake.io, true);
    const relay = fake.listeners.get(END_USER_SESSIONS_EVENT)!;

    relay("u", "4000");
    expect(isTokenSessionEnded("u", SID, 4_000)).toBe(true);
    expect(isTokenSessionEnded("u", SID, 4_001)).toBe(false);

    relay("v", "9999999");
    expect(isTokenSessionEnded("v", SID, 5_000)).toBe(true);
    expect(isTokenSessionEnded("v", SID, 5_001)).toBe(false);

    relay("w", "soon");
    expect(isTokenSessionEnded("w", SID, 1)).toBe(false);
  });
});
