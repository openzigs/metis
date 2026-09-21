/**
 * Phase 11 socket emitter — bridges scheduler/task lifecycle events into
 * the `scheduler:status` and `task:{id}` rooms.
 */
import type { MetisIOServer } from "../socket/server.js";
import type { SchedulerEmitter } from "./types.js";

export function createSchedulerEmitter(io: MetisIOServer): SchedulerEmitter {
  return {
    schedulerStatus(event) {
      io.to("scheduler:status").emit("scheduler:status", { ...event, ts: Date.now() });
    },
    taskStatus(event) {
      io.to(`task:${event.taskId}`).emit("task:status", { ...event, ts: Date.now() });
      // Also broadcast on the scheduler:status channel so the /tasks queue
      // view updates without subscribing to every task individually.
      io.to("scheduler:status").emit("task:status", { ...event, ts: Date.now() });
    },
    taskProgress(event) {
      io.to(`task:${event.taskId}`).emit("task:progress", { ...event, ts: Date.now() });
    },
  };
}

/** Inert emitter used by tests / when Socket.IO isn't wired. */
export const NOOP_SCHEDULER_EMITTER: SchedulerEmitter = {
  schedulerStatus() {},
  taskStatus() {},
  taskProgress() {},
};
