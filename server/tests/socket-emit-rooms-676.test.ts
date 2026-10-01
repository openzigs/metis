/**
 * #676 — the room an emitter sends to must be the room the matching
 * `subscribe:*` handler joined, or the event lands in an empty room and the
 * client hears nothing. Both sides now build the name with the same
 * `@metis/shared` factory; these pin each socket emitter to it.
 */
import { connectorRoom, publishRoom, taskRoom } from "@metis/shared";
import { describe, expect, it } from "vitest";
import type { MetisIOServer } from "../src/lib/socket/server.js";
import { createSocketPublishEmitter } from "../src/lib/publishing/socket-emitter.js";
import { createSchedulerEmitter } from "../src/lib/scheduler/socket-emitter.js";
import { createSocketConnectorEmitter } from "../src/lib/connectors/socket-emitter.js";

function recordingIo() {
  const sent: Array<[room: string, event: string]> = [];
  const io = {
    to: (room: string) => ({ emit: (event: string) => void sent.push([room, event]) }),
  } as unknown as MetisIOServer;
  return { io, sent };
}

describe("socket emitters address the factory-built room (#676)", () => {
  it("publish emitter sends every event to publishRoom(batchId)", () => {
    const { io, sent } = recordingIo();
    const emitter = createSocketPublishEmitter(io);
    const event = { batchId: "b1" } as never;
    emitter.status(event);
    emitter.progress(event);
    emitter.completed(event);
    expect(sent).toEqual([
      [publishRoom("b1"), "publish:status"],
      [publishRoom("b1"), "publish:progress"],
      [publishRoom("b1"), "publish:completed"],
    ]);
  });

  it("scheduler emitter sends task events to taskRoom(taskId)", () => {
    const { io, sent } = recordingIo();
    const emitter = createSchedulerEmitter(io);
    emitter.taskStatus({ taskId: "k1" } as never);
    emitter.taskProgress({ taskId: "k1" } as never);
    expect(sent).toEqual([
      [taskRoom("k1"), "task:status"],
      ["scheduler:status", "task:status"],
      [taskRoom("k1"), "task:progress"],
    ]);
  });

  it("connector emitter sends status and progress to connectorRoom(connectorId)", () => {
    const { io, sent } = recordingIo();
    const emitter = createSocketConnectorEmitter(io);
    emitter.status({ connectorId: "c1" } as never);
    emitter.progress({ connectorId: "c1" } as never);
    expect(sent).toEqual([
      [connectorRoom("c1"), "connector:status"],
      [connectorRoom("c1"), "connector:progress"],
    ]);
  });
});
