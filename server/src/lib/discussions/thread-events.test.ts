/**
 * #1574 — `discussion:changed` emitter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const emit = vi.fn();
const to = vi.fn((_room: string) => ({ emit }));
let io: { to: typeof to } | null = { to };
vi.mock("../socket/registry.js", () => ({ getSocketServer: () => io }));

const { emitDiscussionChanged } = await import("./thread-events.js");

beforeEach(() => {
  vi.clearAllMocks();
  io = { to };
});

describe("emitDiscussionChanged", () => {
  it("emits identifiers only to the thread's project room", () => {
    emitDiscussionChanged("p1", "t1");
    expect(to).toHaveBeenCalledWith("project:p1");
    const [name, payload] = emit.mock.calls[0]!;
    expect(name).toBe("discussion:changed");
    expect(Object.keys(payload).sort()).toEqual(["projectId", "threadId", "ts"]);
    expect(payload).toMatchObject({ projectId: "p1", threadId: "t1" });
  });

  it("does nothing before the socket server is registered", () => {
    io = null;
    expect(() => emitDiscussionChanged("p1", "t1")).not.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });

  it("never throws when the emit fails", () => {
    to.mockImplementationOnce(() => {
      throw new Error("adapter down");
    });
    expect(() => emitDiscussionChanged("p1", "t1")).not.toThrow();
  });
});
