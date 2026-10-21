/**
 * #997 — `comment:changed` payload and emitter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const emit = vi.fn();
const to = vi.fn((_room: string) => ({ emit }));
let io: { to: typeof to } | null = { to };
vi.mock("../socket/registry.js", () => ({ getSocketServer: () => io }));

const { commentChangedEvent, emitCommentChanged } = await import("./comment-events.js");

const onRequirement = {
  id: "t1",
  requirementId: "r1",
  requirement: { projectId: "p1" },
  specKitProjectId: null,
  specKitArtifactName: null,
};
const onArtifact = {
  id: "t2",
  requirementId: null,
  specKitProjectId: "p2",
  specKitArtifactName: "plan.md",
};

beforeEach(() => {
  vi.clearAllMocks();
  io = { to };
});

describe("commentChangedEvent", () => {
  it("places a requirement's thread in the requirement's project", () => {
    expect(commentChangedEvent(onRequirement, 5)).toEqual({
      projectId: "p1",
      threadId: "t1",
      requirementId: "r1",
      artifactName: null,
      ts: 5,
    });
  });

  it("places an artifact's thread in the artifact's project", () => {
    expect(commentChangedEvent(onArtifact, 5)).toEqual({
      projectId: "p2",
      threadId: "t2",
      requirementId: null,
      artifactName: "plan.md",
      ts: 5,
    });
  });

  it("is null for a thread that resolves to no project", () => {
    expect(commentChangedEvent({ ...onRequirement, requirement: null })).toBeNull();
    expect(commentChangedEvent({ ...onArtifact, specKitArtifactName: null })).toBeNull();
  });
});

describe("emitCommentChanged", () => {
  it("emits to the project room", () => {
    emitCommentChanged(onArtifact);
    expect(to).toHaveBeenCalledWith("project:p2");
    expect(emit).toHaveBeenCalledWith(
      "comment:changed",
      expect.objectContaining({ threadId: "t2" }),
    );
  });

  it("does nothing for a thread with no project", () => {
    emitCommentChanged({ ...onArtifact, specKitProjectId: null });
    expect(to).not.toHaveBeenCalled();
  });

  it("does nothing before the socket server is registered", () => {
    io = null;
    expect(() => emitCommentChanged(onRequirement)).not.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });

  it("never throws when the emit fails", () => {
    to.mockImplementationOnce(() => {
      throw new Error("adapter down");
    });
    expect(() => emitCommentChanged(onRequirement)).not.toThrow();
  });
});
