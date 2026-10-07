/**
 * #686 — the `project:` and `user:` rooms are built by `projectRoom()` /
 * `userRoom()` from `@metis/shared`, as the join handlers build them. These pin
 * the emitters that had no room test to the literal room name, so routing them
 * through the factories is shown not to have renamed a room.
 */
import { describe, expect, it } from "vitest";
import type { MetisIOServer } from "../src/lib/socket/server.js";
import { createSocketUsageEmitter } from "../src/lib/finops/socket-emitter.js";
import { createSocketRunnerEmitter } from "../src/lib/async/socket-emitter.js";
import { createSocketConnectorEmitter } from "../src/lib/connectors/socket-emitter.js";

function recordingIo() {
  const sent: Array<[room: string, event: string]> = [];
  const io = {
    to: (room: string) => ({ emit: (event: string) => void sent.push([room, event]) }),
  } as unknown as MetisIOServer;
  return { io, sent };
}

describe("project-room emitters keep their room names (#686)", () => {
  it("usage emitter sends usage:tick to project:{projectId}", () => {
    const { io, sent } = recordingIo();
    createSocketUsageEmitter(io)("p1", { projectId: "p1" } as never);
    expect(sent).toEqual([["project:p1", "usage:tick"]]);
  });

  it("background-run emitter sends status to project:{projectId} and steps to run:{runId}", () => {
    const { io, sent } = recordingIo();
    const emitter = createSocketRunnerEmitter(io);
    emitter.status({ id: "r1", projectId: "p1", status: "running" } as never);
    emitter.step({ runId: "r1", kind: "log", content: "x", ts: 1 });
    expect(sent).toEqual([
      ["project:p1", "bg-run:status"],
      ["run:r1", "bg-run:step"],
    ]);
  });

  it("connector progress also reaches project:{projectId} when the event names one", () => {
    const { io, sent } = recordingIo();
    const emitter = createSocketConnectorEmitter(io);
    emitter.progress({ connectorId: "c1", projectId: "p1" } as never);
    emitter.progress({ connectorId: "c2" } as never);
    expect(sent).toEqual([
      ["connector:c1", "connector:progress"],
      ["project:p1", "connector:progress"],
      ["connector:c2", "connector:progress"],
    ]);
  });
});
