/**
 * #1290 — two small pieces of per-process state the project-data room
 * re-judgement (`project-data-rooms.ts`) reads, kept free of any database or
 * Socket.IO import so the presence modules can depend on them cheaply.
 *
 * 1. The project each room belongs to, recorded by the room's join rule when
 *    it reads the resource (an analysis, connector, run, session, thread or
 *    Spec Kit artifact never moves to another project). A project soft-delete
 *    or workspace delete then re-judges only the rooms of those projects, plus
 *    any room this process holds no record for, which only a lookup can place
 *    — the same rule as `jobTouchesProjects` for job rooms. Bounded: past
 *    {@link MAX_REMEMBERED_ROOMS} the oldest record is dropped, and a dropped
 *    room is simply judged on the next project eviction.
 * 2. Eviction listeners: a room that keeps state beside its Socket.IO
 *    membership (a presence list) registers one per socket, so a socket the
 *    re-judgement takes out of the room is also taken off that list.
 */
import { createChildLogger } from "../logger.js";

const log = createChildLogger("socket:room-scope");

/** How many room → project records one process keeps. */
export const MAX_REMEMBERED_ROOMS = 50_000;

/** Room → its project id, or `null` for a room no project scopes. */
const roomProjects = new Map<string, string | null>();

/** Record that `room` belongs to `projectId` (`null`: to no project). */
export function rememberRoomProject(room: string, projectId: string | null): void {
  roomProjects.delete(room);
  if (roomProjects.size >= MAX_REMEMBERED_ROOMS) {
    const oldest = roomProjects.keys().next().value;
    if (oldest !== undefined) roomProjects.delete(oldest);
  }
  roomProjects.set(room, projectId);
}

/**
 * Whether a re-judgement scoped to `projectIds` must look at `room`: a room of
 * one of those projects, or one this process holds no record for. A room
 * recorded as belonging to no project is never touched by a project change.
 */
export function roomTouchesProjects(room: string, projectIds: ReadonlySet<string>): boolean {
  if (!roomProjects.has(room)) return true;
  const projectId = roomProjects.get(room);
  return projectId !== null && projectId !== undefined && projectIds.has(projectId);
}

/** Test seam: forget every recorded room. */
export function _resetRoomProjects(): void {
  roomProjects.clear();
}

type EvictionListener = (room: string) => void;

const evictionListeners = new WeakMap<object, Set<EvictionListener>>();

/** Call `listener` with each room the re-judgement takes `socket` out of. */
export function onRoomEvicted(socket: object, listener: EvictionListener): void {
  let listeners = evictionListeners.get(socket);
  if (!listeners) {
    listeners = new Set();
    evictionListeners.set(socket, listeners);
  }
  listeners.add(listener);
}

/** Tell `socket`'s listeners it was taken out of `room`. Never throws. */
export function roomEvicted(socket: object, room: string): void {
  for (const listener of evictionListeners.get(socket) ?? []) {
    try {
      listener(room);
    } catch (err) {
      // A listener's failure must not stop the others or the re-judgement.
      log.warn("Room eviction listener failed", { room, error: (err as Error).message });
    }
  }
}
