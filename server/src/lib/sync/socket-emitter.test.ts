/**
 * Issue #78 — the drift badge needs a live count, and nothing broadcast a drift
 * event: `reconcile-service.ts` accepted an `emitDrift` dependency that NO
 * caller ever supplied, so `DriftEvent` rows appeared in the database and no
 * connected client heard about them.
 *
 * The emitter fans out to the `project:{id}` room, which `subscribe:project`
 * gates on `actorCanAccessProject` — a client that cannot read the project is
 * never in the room, so this carries no drift detail to unauthorized users.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DriftEventRow } from "@metis/shared";
import { registerSocketServer } from "../socket/registry.js";
import { createSocketDriftEmitter } from "./socket-emitter.js";

function fakeIo() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { io: { to } as never, to, emit };
}

function driftRow(over: Partial<DriftEventRow> = {}): DriftEventRow {
  return {
    id: "drift-1",
    publishedIssueId: "pi-1",
    projectId: "proj-1",
    requirementId: "req-1",
    source: "github",
    deliveryId: "d-1",
    action: "edited",
    fieldDiffs: [],
    externalSnapshot: {},
    localSnapshot: {},
    status: "pending",
    resolution: null,
    resolvedById: null,
    resolvedAt: null,
    createdAt: "2026-09-22T10:00:00.000Z",
    ...over,
  } as DriftEventRow;
}

beforeEach(() => {
  registerSocketServer(null as never);
});

describe("createSocketDriftEmitter — #78", () => {
  it("emits `drift:detected` to the project room", () => {
    const { io, to, emit } = fakeIo();
    registerSocketServer(io);

    createSocketDriftEmitter()("proj-1", driftRow());

    expect(to).toHaveBeenCalledWith("project:proj-1");
    expect(emit).toHaveBeenCalledWith(
      "drift:detected",
      expect.objectContaining({
        projectId: "proj-1",
        driftEventId: "drift-1",
        requirementId: "req-1",
        status: "pending",
      }),
    );
  });

  /** The badge only needs a nudge to re-read the count — no issue content. */
  it("carries no external or local issue content", () => {
    const { io, emit } = fakeIo();
    registerSocketServer(io);

    createSocketDriftEmitter()(
      "proj-1",
      driftRow({
        externalSnapshot: { title: "SECRET-TITLE" } as never,
        localSnapshot: { title: "SECRET-LOCAL" } as never,
      }),
    );

    expect(JSON.stringify(emit.mock.calls)).not.toContain("SECRET");
  });

  it("is a no-op before the IO server is registered", () => {
    expect(() => createSocketDriftEmitter()("proj-1", driftRow())).not.toThrow();
  });

  it("swallows a transport error rather than failing the webhook", () => {
    const to = vi.fn(() => {
      throw new Error("socket down");
    });
    registerSocketServer({ to } as never);

    expect(() => createSocketDriftEmitter()("proj-1", driftRow())).not.toThrow();
  });
});
