/**
 * #1212 review — `createSocketServer` wires the project-room re-judgement
 * relays when, and only when, it is built with a cluster adapter. The relay
 * handlers themselves are unit-tested in `project-room-eviction.test.ts`; this
 * pins that the server actually registers them, so a clustered deployment's
 * other replicas act on a member removal instead of waiting for the next sweep.
 *
 * In-process: the server is built on an HTTP server that never listens, and the
 * stand-in "cluster" adapter is socket.io's own in-memory adapter class, which
 * is all `createSocketServer` needs to treat the server as clustered.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { createSocketServer, type MetisIOServer } from "../src/lib/socket/server.js";
import {
  REJUDGE_ALL_PROJECT_ROOMS_EVENT,
  REJUDGE_PROJECT_ROOM_EVENT,
  REJUDGE_USER_PROJECT_ROOMS_EVENT,
} from "../src/lib/socket/project-room-eviction.js";
import { readEpoch } from "../src/lib/socket/revocation-relay.js";

/** socket.io's default in-memory adapter class (`socket.io-adapter` is not a direct dependency). */
const InMemoryAdapter = new Server().of("/").adapter.constructor;

const EVENTS = [
  REJUDGE_PROJECT_ROOM_EVENT,
  REJUDGE_USER_PROJECT_ROOMS_EVENT,
  REJUDGE_ALL_PROJECT_ROOMS_EVENT,
];

let io: MetisIOServer | null = null;
afterEach(async () => {
  await io?.close();
  io = null;
});

/** The server-side-event listeners `onRelayedRevocation` registered for `event`. */
const relayListeners = (server: MetisIOServer, event: string) =>
  (
    server.of("/") as unknown as { listeners(e: string): Array<(...a: unknown[]) => void> }
  ).listeners(event);

describe("#1212 — createSocketServer wires the project-room relays", () => {
  it("registers each relay on a clustered server, and a relayed re-judgement moves the eviction epoch", () => {
    io = createSocketServer(http.createServer(), { adapter: InMemoryAdapter as never });
    for (const event of EVENTS) expect(relayListeners(io, event)).toHaveLength(1);

    const before = readEpoch(io, "eviction");
    relayListeners(io, REJUDGE_USER_PROJECT_ROOMS_EVENT)[0]!("u-removed");
    expect(readEpoch(io, "eviction")).toBe(before + 1);
  });

  it("registers none without a cluster adapter", () => {
    io = createSocketServer(http.createServer());
    for (const event of EVENTS) expect(relayListeners(io, event)).toHaveLength(0);
  });
});
