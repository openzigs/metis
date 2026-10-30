/**
 * #1574 — `review:changed` emitter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const emit = vi.fn();
const to = vi.fn((_room: string) => ({ emit }));
let io: { to: typeof to } | null = { to };
vi.mock("../socket/registry.js", () => ({ getSocketServer: () => io }));

const { emitReviewChanged } = await import("./review-events.js");

beforeEach(() => {
  vi.clearAllMocks();
  io = { to };
});

describe("emitReviewChanged", () => {
  it("emits identifiers only to the review's project room", () => {
    emitReviewChanged("p1", "rev-1");
    expect(to).toHaveBeenCalledWith("project:p1");
    expect(emit).toHaveBeenCalledTimes(1);
    const [name, payload] = emit.mock.calls[0]!;
    expect(name).toBe("review:changed");
    expect(Object.keys(payload).sort()).toEqual(["projectId", "reviewId", "ts"]);
    expect(payload).toMatchObject({ projectId: "p1", reviewId: "rev-1" });
  });

  it("does nothing before the socket server is registered", () => {
    io = null;
    expect(() => emitReviewChanged("p1", "rev-1")).not.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });

  it("never throws when the emit fails", () => {
    to.mockImplementationOnce(() => {
      throw new Error("adapter down");
    });
    expect(() => emitReviewChanged("p1", "rev-1")).not.toThrow();
  });
});
