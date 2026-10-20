/**
 * #1251 — take a socket out of a `job:{id}` room once it may no longer join it.
 *
 * `subscribe:job` judges a socket once, when it joins (`resolveJobRoomScope`):
 * a job scoped to a project takes that project's read rule, an impact analysis
 * takes the rule of `GET /api/impact-analyses/:id`, which #1232 widened to the
 * members of the run's projects' workspaces. So a member removed from the
 * workspace afterwards kept receiving the run's events until they reconnected.
 *
 * This is the job-room twin of `rejudgeProjectRooms` (`project-rooms.ts`), and
 * is driven from the same places: the member, workspace and project evictions
 * (`project-room-eviction.ts`) and the re-validation pass
 * (`revalidateLocalSockets`). It re-judges with the join's own rule — never a
 * second one — so whoever the join would admit now stays, and everyone else
 * leaves.
 */
import { jobRoom, type AuthPayload } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { getJobScope } from "./job-events.js";
import type { RejudgedSocket } from "./project-rooms.js";
import { readEpoch } from "./revocation-relay.js";
import { resolveJobRoomScope } from "./room-access.js";
import type { MetisIOServer } from "./server.js";

const log = createChildLogger("socket:job-room");

/** Prefix of every `job:{id}` room. */
export const JOB_ROOM_PREFIX = jobRoom("");

/** The job ids of the `job:{id}` rooms `socket` is in. */
export function jobIdsOf(socket: Pick<RejudgedSocket, "rooms">): string[] {
  return [...socket.rooms]
    .filter((room) => room.startsWith(JOB_ROOM_PREFIX))
    .map((room) => room.slice(JOB_ROOM_PREFIX.length));
}

/**
 * Whether a re-judgement scoped to `projectIds` must look at job `jobId`: a
 * job of one of those projects, a cross-project job (an impact analysis spans
 * projects, and its scope names none), or a job this process holds no scope
 * for, which only a lookup can place.
 */
export function jobTouchesProjects(jobId: string, projectIds: ReadonlySet<string>): boolean {
  const scope = getJobScope(jobId);
  return !scope || scope.projectId === null || projectIds.has(scope.projectId);
}

/**
 * Re-judge the job rooms `socket` is in against `user` (the live user), leaving
 * each one the rule now refuses. `only` limits it to the jobs it accepts.
 *
 * A check that throws keeps the room when failing open (the periodic sweep: a
 * database blip is not evidence of revocation, and the next pass re-judges).
 * Failing closed, it leaves the room AND closes the transport, as
 * `rejudgeProjectRooms` does: the client reconnects and re-subscribes, so a
 * member the error wrongly removed is re-admitted rather than silently left
 * without live updates. Never rejects.
 */
export async function rejudgeJobRooms(
  socket: RejudgedSocket,
  user: AuthPayload,
  opts: { failClosed: boolean; only?: (jobId: string) => boolean },
): Promise<void> {
  const jobIds = jobIdsOf(socket).filter((jobId) => !opts.only || opts.only(jobId));
  let reconnect = false;
  for (const jobId of jobIds) {
    const room = jobRoom(jobId);
    let allowed: boolean;
    try {
      allowed = (await resolveJobRoomScope(user, jobId, { onStoreError: "throw" })) !== null;
    } catch (err) {
      log.warn("Job room re-judgement failed", {
        socketId: socket.id,
        room,
        failClosed: opts.failClosed,
        error: (err as Error).message,
      });
      if (!opts.failClosed) continue;
      allowed = false;
      reconnect = true;
    }
    if (allowed) continue;
    try {
      await socket.leave(room);
    } catch (err) {
      log.warn("Socket could not leave a job room", {
        socketId: socket.id,
        room,
        error: (err as Error).message,
      });
    }
  }
  if (reconnect) socket.conn.close();
}

/**
 * #1251 — a `subscribe:job` whose check was in flight while an eviction ran
 * could not be seen by it: the socket was not yet in the room. `epochBefore` is
 * the eviction epoch read before the check; once the socket has joined, a moved
 * epoch means an eviction ran in between, so the join is judged again, failing
 * closed (the `subscribe:project` handler does the same). Never rejects.
 */
export async function recheckJobJoinAfterEviction(
  socket: RejudgedSocket & { nsp: { server: MetisIOServer } },
  user: AuthPayload,
  jobId: string,
  epochBefore: number,
): Promise<void> {
  if (readEpoch(socket.nsp.server, "eviction") === epochBefore) return;
  await rejudgeJobRooms(socket, user, { failClosed: true, only: (id) => id === jobId });
}
