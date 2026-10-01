/**
 * #672 — one factory per server room kind that the UI follows and later leaves.
 *
 * Each returns a `RoomFollow` whose `room` is the `@metis/shared` room name the
 * server's handler joins, paired with the subscribe and unsubscribe events that
 * join and leave exactly that room. `keepRoomSubscribed` reference-counts by
 * `room`, so deriving all three from one id here is what stops a call site's
 * count key drifting from the room it actually joined.
 */
import type { Socket } from "socket.io-client";
import {
  analysisRoom,
  presenceRoom,
  publishRoom,
  sessionRoom,
  taskRoom,
  threadRoom,
} from "@metis/shared";
import type { RoomFollow } from "./socket-subscription";

type EmitSocket = Pick<Socket, "emit">;

function roomFollow(
  socket: EmitSocket,
  room: string,
  subscribeEvent: string,
  unsubscribeEvent: string,
  payload: Record<string, string>,
): RoomFollow {
  return {
    room,
    subscribe: () => socket.emit(subscribeEvent, payload),
    unsubscribe: () => socket.emit(unsubscribeEvent, payload),
  };
}

export const threadFollow = (socket: EmitSocket, threadId: string): RoomFollow =>
  roomFollow(socket, threadRoom(threadId), "subscribe:thread", "unsubscribe:thread", { threadId });

export const sessionFollow = (socket: EmitSocket, sessionId: string): RoomFollow =>
  roomFollow(socket, sessionRoom(sessionId), "subscribe:session", "unsubscribe:session", {
    sessionId,
  });

export const taskFollow = (socket: EmitSocket, taskId: string): RoomFollow =>
  roomFollow(socket, taskRoom(taskId), "subscribe:task", "unsubscribe:task", { taskId });

export const analysisFollow = (socket: EmitSocket, analysisId: string): RoomFollow =>
  roomFollow(socket, analysisRoom(analysisId), "subscribe:analysis", "unsubscribe:analysis", {
    analysisId,
  });

export const publishFollow = (socket: EmitSocket, batchId: string): RoomFollow =>
  roomFollow(socket, publishRoom(batchId), "subscribe:publish", "unsubscribe:publish", { batchId });

export const presenceFollow = (
  socket: EmitSocket,
  artifactType: string,
  artifactId: string,
): RoomFollow =>
  roomFollow(socket, presenceRoom(artifactType, artifactId), "presence:join", "presence:leave", {
    artifactType,
    artifactId,
  });
