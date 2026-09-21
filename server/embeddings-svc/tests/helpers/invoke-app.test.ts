/**
 * Issue #1379 — the socket-free request driver's own tests.
 *
 * These pin `invoke()` against a real Express app, so a drift in Express's or Node's
 * response serialization fails HERE rather than as a confusing assertion in a caller.
 *
 * Fidelity to a real round-trip was established by differential measurement, not by
 * assertion: `invoke()` and `supertest` were run side by side against the sidecar's own
 * app over seven request shapes (200/400/401/404 on `/healthz`, `/readyz`, `/embed`,
 * `/rerank`, plus an unknown route) and agreed on status, parsed body and `content-type`
 * in every one. That comparison is deliberately NOT committed: it would put the very
 * ephemeral-port dependency this helper exists to remove back into the suite.
 */
import express, { type Express } from "express";
import { describe, expect, it } from "vitest";
import { invoke } from "./invoke-app.js";

function app(): Express {
  const a = express();
  a.disable("x-powered-by");
  a.use(express.json());
  a.get("/json", (_req, res) => {
    res.json({ ok: true, n: 1 });
  });
  a.get("/empty", (_req, res) => {
    res.status(204).end();
  });
  a.get("/text", (_req, res) => {
    res.type("text/plain").send("plain body");
  });
  a.get("/echo-header", (req, res) => {
    res.json({ seen: req.header("x-custom") ?? null, auth: req.header("authorization") ?? null });
  });
  a.post("/echo", (req, res) => {
    res.status(201).json({ received: req.body as unknown, method: req.method });
  });
  a.get("/streamed", (_req, res) => {
    // No Content-Length, so Node frames this chunked.
    res.type("application/json");
    res.write('{"part":');
    res.write('"two writes"}');
    res.end();
  });
  a.get("/boom", () => {
    throw new Error("handler exploded");
  });
  a.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  return a;
}

describe("#1379 — invoke() drives Express without a socket", () => {
  it("returns the status, parsed JSON body and lower-cased headers", async () => {
    const res = await invoke(app(), { url: "/json" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, n: 1 });
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.text).toBe(JSON.stringify({ ok: true, n: 1 }));
  });

  it("round-trips a JSON request body through express.json()", async () => {
    const res = await invoke(app(), {
      method: "POST",
      url: "/echo",
      json: { texts: ["alpha", "bravo"] },
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ received: { texts: ["alpha", "bravo"] }, method: "POST" });
  });

  it("delivers request headers to the handler, whatever case they were given in", async () => {
    const res = await invoke(app(), {
      url: "/echo-header",
      headers: { "X-Custom": "yes", Authorization: "Bearer tok" },
    });

    expect(res.body).toEqual({ seen: "yes", auth: "Bearer tok" });
  });

  it("handles a body-less response without inventing one", async () => {
    const res = await invoke(app(), { url: "/empty" });

    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(res.body).toBeUndefined();
  });

  it("leaves a non-JSON body unparsed rather than guessing", async () => {
    const res = await invoke(app(), { url: "/text" });

    expect(res.status).toBe(200);
    expect(res.text).toBe("plain body");
    expect(res.body).toBeUndefined();
  });

  it("strips chunked framing from a response Node did not length-delimit", async () => {
    const res = await invoke(app(), { url: "/streamed" });

    // No Content-Length means Node framed it chunked; the sizes must not survive
    // into `text` (they did until this test was written).
    expect(res.headers["content-length"]).toBeUndefined();
    expect(res.text).toBe('{"part":"two writes"}');
    expect(res.body).toEqual({ part: "two writes" });
  });

  it("reaches the app's own 404 fallthrough", async () => {
    const res = await invoke(app(), { url: "/nowhere" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("surfaces a throwing handler as Express's 500 rather than hanging", async () => {
    const res = await invoke(app(), { url: "/boom" });

    expect(res.status).toBe(500);
  });

  it("defaults to GET and sends no content-length when there is no body", async () => {
    const seen: Array<string | undefined> = [];
    const a = express();
    a.get("/probe", (req, res) => {
      seen.push(req.method, req.headers["content-length"], req.headers["content-type"]);
      res.json({});
    });

    await invoke(a, { url: "/probe" });

    expect(seen).toEqual(["GET", undefined, undefined]);
  });
});
