/**
 * Discovery notification tests (epic #663, issue #669).
 *
 * Verifies that the socket emitter correctly broadcasts connector:discovery
 * events to the project room.
 */
import { describe, expect, it, vi } from "vitest";
import { createSocketConnectorEmitter } from "../src/lib/connectors/socket-emitter.js";
import type { MetisIOServer } from "../src/lib/socket/server.js";

describe("Discovery notification (#669)", () => {
  it("emits connector:discovery to project room when connections found", () => {
    const emitFn = vi.fn();
    const fakeIO = {
      to: vi.fn(() => ({ emit: emitFn })),
    } as unknown as MetisIOServer;

    const emitter = createSocketConnectorEmitter(fakeIO);
    emitter.discovery({
      projectId: "proj-1",
      connectorId: "repo-1",
      repoLabel: "backend",
      connectionsFound: 3,
    });

    expect(fakeIO.to).toHaveBeenCalledWith("project:proj-1");
    expect(emitFn).toHaveBeenCalledWith(
      "connector:discovery",
      expect.objectContaining({
        projectId: "proj-1",
        connectorId: "repo-1",
        repoLabel: "backend",
        connectionsFound: 3,
      }),
    );
  });

  it("includes a timestamp in the emitted event", () => {
    const emitFn = vi.fn();
    const fakeIO = {
      to: vi.fn(() => ({ emit: emitFn })),
    } as unknown as MetisIOServer;

    const before = Date.now();
    const emitter = createSocketConnectorEmitter(fakeIO);
    emitter.discovery({
      projectId: "proj-2",
      connectorId: "repo-2",
      repoLabel: "frontend",
      connectionsFound: 1,
    });
    const after = Date.now();

    const emittedData = emitFn.mock.calls[0][1] as { ts: number };
    expect(emittedData.ts).toBeGreaterThanOrEqual(before);
    expect(emittedData.ts).toBeLessThanOrEqual(after);
  });
});
