/**
 * FinOps usage emitter — epic #164.
 *
 * Fans each `recordUsage` tick out to the `project:{projectId}` Socket.IO room
 * so the usage page re-renders without polling. Wired in `server.ts` through
 * `setUsageEmitter` once the live io is ready. #686 — the room comes from
 * `projectRoom()`, the factory the `subscribe:project` handler joins with.
 */
import { projectRoom } from "@metis/shared";
import type { MetisIOServer } from "../socket/server.js";
import type { setUsageEmitter } from "./token-tracker.js";

type UsageEmitter = NonNullable<Parameters<typeof setUsageEmitter>[0]>;

export function createSocketUsageEmitter(io: MetisIOServer): UsageEmitter {
  return (projectId, payload) => {
    io.to(projectRoom(projectId)).emit("usage:tick", payload);
  };
}
