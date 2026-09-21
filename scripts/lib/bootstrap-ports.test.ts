import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { EXPECTED_PORTS, probePort, probePorts } from "./bootstrap-ports.mjs";

/** A fake net.Server that emits the configured outcome on listen(). */
class FakeServer extends EventEmitter {
  closed = false;
  constructor(private readonly outcome: "listening" | "in-use" | "error") {
    super();
  }
  listen() {
    queueMicrotask(() => {
      if (this.outcome === "listening") this.emit("listening");
      else if (this.outcome === "in-use") {
        const err = new Error("EADDRINUSE") as NodeJS.ErrnoException;
        err.code = "EADDRINUSE";
        this.emit("error", err);
      } else {
        const err = new Error("boom") as NodeJS.ErrnoException;
        err.code = "EACCES";
        this.emit("error", err);
      }
    });
  }
  close() {
    this.closed = true;
  }
}

describe("EXPECTED_PORTS", () => {
  it("covers the local-dev stack ports", () => {
    expect(EXPECTED_PORTS).toEqual([3000, 4000, 5050, 5432]);
  });
});

describe("probePort", () => {
  it("reports free when the bind succeeds", async () => {
    const server = new FakeServer("listening");
    const r = await probePort(4000, { createServer: () => server });
    expect(r).toEqual({ port: 4000, free: true });
    expect(server.closed).toBe(true);
  });

  it("reports in use on EADDRINUSE", async () => {
    const r = await probePort(4000, { createServer: () => new FakeServer("in-use") });
    expect(r.free).toBe(false);
    expect(r.reason).toBe("in use");
  });

  it("reports a generic bind error code", async () => {
    const r = await probePort(80, { createServer: () => new FakeServer("error") });
    expect(r.free).toBe(false);
    expect(r.reason).toBe("EACCES");
  });

  it("handles a synchronous listen() throw", async () => {
    const server = new EventEmitter() as unknown as { listen: () => void; close: () => void };
    server.listen = () => {
      throw new Error("listen exploded");
    };
    server.close = () => {};
    const r = await probePort(4000, { createServer: () => server as never });
    expect(r.free).toBe(false);
    expect(r.reason).toBe("listen exploded");
  });

  it("times out cleanly when nothing settles", async () => {
    const server = new EventEmitter() as unknown as { listen: () => void; close: () => void };
    server.listen = () => {};
    server.close = () => {};
    const r = await probePort(4000, { createServer: () => server as never, timeoutMs: 5 });
    expect(r.free).toBe(false);
    expect(r.reason).toContain("timed out");
  });
});

describe("probePorts", () => {
  it("probes every requested port", async () => {
    const r = await probePorts([1111, 2222], {
      createServer: () => new FakeServer("listening"),
    });
    expect(r.map((x) => x.port)).toEqual([1111, 2222]);
    expect(r.every((x) => x.free)).toBe(true);
  });
});
