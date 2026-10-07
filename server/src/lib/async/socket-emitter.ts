/**
 * Background-run emitter — epic #156.
 *
 * Broadcasts `bg-run:status` into the run's project room and `bg-run:step`
 * into the run's own room (`subscribe:bg-run`). Wired in `server.ts` through
 * `configureAsyncRunner`. #686 — both rooms come from their `@metis/shared`
 * factories, the ones the join handlers use.
 */
import { bgRunRoom, projectRoom } from "@metis/shared";
import type { MetisIOServer } from "../socket/server.js";
import type { RunnerEmitter } from "./runner.js";

export function createSocketRunnerEmitter(io: MetisIOServer): RunnerEmitter {
  return {
    status: (run) => {
      io.to(projectRoom(run.projectId)).emit("bg-run:status", {
        ...run,
        ts: Date.now(),
      });
    },
    step: (e) => {
      io.to(bgRunRoom(e.runId)).emit("bg-run:step", e);
    },
  };
}
