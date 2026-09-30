/**
 * #340 / #353 — where an `mcp:status` event may go.
 *
 * - `global` events go to the shared `mcp:status` room, which any `mcp.manage`
 *   holder may join (unchanged).
 * - A `scope: "user"` server is one user's own (#340), so its label, status and
 *   lastError go ONLY to a room its owner joins and to the system admins'
 *   room. A user server with no owner on record reaches admins only.
 * - A `scope: "project"` server (#353) follows `assertProjectAccess`
 *   (`lib/custom-agents/authz.ts`): its events go to the room of the project's
 *   workspace — joined only by subscribers with a live membership of that
 *   workspace, read at subscribe time (#562) — and to the admins' room. A
 *   legacy project with no workspace is open to every authenticated user, so
 *   its events go to the shared room. An
 *   unknown project, a project server with no project id, or a failed lookup
 *   reaches admins only (fail closed).
 *
 * No Socket.IO or Prisma import, so the socket server and the MCP bootstrap
 * share one definition of the room names and the emitter is testable alone.
 */
import type { MCPServerConfig, MCPStatusEvent } from "./types.js";

/** Shared room: `global` events and those of projects with no workspace. */
export const MCP_STATUS_ROOM = "mcp:status";
/** System admins: every user-scope and workspace-project server's events. */
export const MCP_STATUS_ADMIN_ROOM = "mcp:status:admin";
/** One owner's user-scope server events. The id is always the verified JWT's. */
export const mcpStatusOwnerRoom = (userId: string): string => `mcp:status:user:${userId}`;
/**
 * One workspace's project-scope server events. Ids come from the subscriber's
 * live, non-deleted memberships — never the token's `workspaces` claim, which
 * outlives a workspace deletion or the user's removal (#562).
 */
export const mcpStatusWorkspaceRoom = (workspaceId: string): string =>
  `mcp:status:workspace:${workspaceId}`;

/**
 * Who may see an event's server. `project` is the server's project as looked up
 * — `null` when the project is unknown (or the lookup failed).
 */
export interface MCPStatusAudience {
  ownerId?: string | null;
  project?: { workspaceId: string | null } | null;
}

/** The rooms `event` is emitted to. */
export function mcpStatusRooms(
  event: Pick<MCPStatusEvent, "scope">,
  audience: MCPStatusAudience = {},
): string[] {
  if (event.scope === "user") {
    return audience.ownerId
      ? [mcpStatusOwnerRoom(audience.ownerId), MCP_STATUS_ADMIN_ROOM]
      : [MCP_STATUS_ADMIN_ROOM];
  }
  if (event.scope === "project") {
    const project = audience.project;
    if (!project) return [MCP_STATUS_ADMIN_ROOM];
    if (!project.workspaceId) return [MCP_STATUS_ROOM];
    return [mcpStatusWorkspaceRoom(project.workspaceId), MCP_STATUS_ADMIN_ROOM];
  }
  return [MCP_STATUS_ROOM];
}

/**
 * The rooms a subscriber that passed the `mcp.manage` gate joins.
 * `liveWorkspaceIds` must come from `readLiveWorkspaceIds`, not from the token
 * (#562); it is a separate argument so the verified payload, which carries the
 * stale `workspaces` claim, cannot supply it by being passed whole.
 */
export function mcpStatusRoomsFor(
  user: { userId: string; role: string },
  liveWorkspaceIds: readonly string[] = [],
): string[] {
  const rooms = [MCP_STATUS_ROOM, mcpStatusOwnerRoom(user.userId)];
  for (const ws of liveWorkspaceIds) rooms.push(mcpStatusWorkspaceRoom(ws));
  if (user.role === "admin") rooms.push(MCP_STATUS_ADMIN_ROOM);
  return rooms;
}

/** True for every room `mcpStatusRoomsFor` can produce. */
export const isMcpStatusRoom = (room: string): boolean =>
  room === MCP_STATUS_ROOM || room.startsWith(`${MCP_STATUS_ROOM}:`);

/** The slice of a Socket.IO server the emitter needs. */
export interface MCPStatusSink {
  to(rooms: string[]): { emit(ev: "mcp:status", event: MCPStatusEvent): unknown };
}

/**
 * #360 — how long a project lookup may take before the event is routed as if
 * the lookup failed (admins only). Prisma applies no query timeout, and every
 * event is queued behind the one before it, so an unbounded lookup would stall
 * every later event, global and user-scope ones included.
 */
export const MCP_STATUS_LOOKUP_TIMEOUT_MS = 5_000;

/** Resolves a project's workspace; `null` when the project does not exist. */
export type ProjectWorkspaceLookup = (
  projectId: string,
) => Promise<{ workspaceId: string | null } | null>;

/**
 * Build the lifecycle manager's `emitStatus` listener. A project-scope event
 * needs an async project lookup, so every event is queued behind the previous
 * one: a later `global` event can never overtake an earlier project event, and
 * one server's `starting` → `ready` sequence stays in order.
 *
 * Returns the listener plus `drain()`, which resolves once every queued event
 * has been emitted. `onLookupError` hears a failed or timed-out project lookup
 * (the event then reaches admins only) and a failed emit. A lookup is bounded
 * by `lookupTimeoutMs` (#360) so one hung query cannot stall the queue.
 */
export function createMcpStatusEmitter(
  sink: MCPStatusSink,
  lookupProject: ProjectWorkspaceLookup,
  onLookupError: (err: unknown, event: MCPStatusEvent) => void = () => {},
  { lookupTimeoutMs: requestedTimeoutMs }: { lookupTimeoutMs?: number } = {},
): {
  emit: (event: MCPStatusEvent, config?: MCPServerConfig) => void;
  drain: () => Promise<void>;
} {
  let tail: Promise<void> = Promise.resolve();
  // 0, a negative or a non-finite value would fire at once and send every
  // project event to admins only; fall back to the default instead.
  const lookupTimeoutMs =
    requestedTimeoutMs !== undefined &&
    Number.isFinite(requestedTimeoutMs) &&
    requestedTimeoutMs > 0
      ? requestedTimeoutMs
      : MCP_STATUS_LOOKUP_TIMEOUT_MS;

  const boundedLookup = (projectId: string): ReturnType<ProjectWorkspaceLookup> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`project lookup timed out after ${lookupTimeoutMs}ms`)),
        lookupTimeoutMs,
      );
      // A pending lookup must not keep the process alive on shutdown.
      timer.unref?.();
    });
    // Deferred through .then so a lookup that throws synchronously becomes a
    // rejection the race settles on; the timer is then cleared, not left to
    // reject with no handler (PR #377 review).
    const lookup = Promise.resolve().then(() => lookupProject(projectId));
    return Promise.race([lookup, timeout]).finally(() => clearTimeout(timer));
  };

  const audienceFor = async (
    event: MCPStatusEvent,
    config?: MCPServerConfig,
  ): Promise<MCPStatusAudience> => {
    if (event.scope === "user") return { ownerId: config?.userId };
    if (event.scope !== "project") return {};
    const projectId = event.projectId ?? config?.projectId;
    if (!projectId) return { project: null };
    try {
      return { project: await boundedLookup(projectId) };
    } catch (err) {
      onLookupError(err, event);
      return { project: null };
    }
  };

  return {
    emit: (event, config) => {
      tail = tail
        .then(async () => {
          const rooms = mcpStatusRooms(event, await audienceFor(event, config));
          sink.to(rooms).emit("mcp:status", event);
        })
        // A throwing sink must not reject the queue, or every later event is lost.
        .catch((err: unknown) => onLookupError(err, event));
    },
    drain: () => tail,
  };
}
