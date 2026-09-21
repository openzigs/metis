/**
 * Issue #1379 — drive an Express app WITHOUT a TCP socket.
 *
 * ## Why this exists
 *
 * `tests/app-forward-batch.test.ts` asserts a pure-logic invariant (#807: which text
 * batches reach the model's forward pass). It was doing so through `supertest`, which
 * boots a fresh listener on an ephemeral port and performs a real loopback round-trip
 * per request. That makes a correctness assertion depend on machine-global, finite,
 * contended resources — the 16,384-entry ephemeral port range (macOS holds each closed
 * pair in TIME_WAIT for 2×MSL = 30 s), the listen backlog, and socket FDs — all of which
 * the ~1,100-file `server` package's own `supertest` suites consume hard while the
 * monorepo fan-out runs everything at once.
 *
 * Measured on this machine (12 cores), same test, no code change:
 *
 * ```
 *   idle                                            2–3 ms
 *   24 CPU hogs + 12 loopback-churn processes    6,291 ms
 *   ephemeral range saturated (16,357 TIME_WAIT) connect EADDRNOTAVAIL
 * ```
 *
 * The reported CI/local failure was `(7 tests | 1 failed) 20076ms` against this
 * package's `testTimeout: 20_000` — i.e. the round-trip stalled past the timeout, not
 * a regression in the batching logic.
 *
 * ## What this keeps, and what it drops
 *
 * KEEPS: the real `express` app, its router, `express.json()`, the auth middleware, the
 * Zod schema, the handler, and Node's own response serializer — `app(req, res)` is
 * exactly the contract `http.createServer` invokes, so nothing in the app's code path
 * changes. The request and response are genuine `IncomingMessage`/`ServerResponse`
 * instances.
 *
 * DROPS: the kernel. No `listen()`, no `connect()`, no port, no FD. `PassThrough` stands
 * in for the socket, so the response is serialized by Node exactly as it would be on the
 * wire and then parsed back here.
 *
 * This is NOT a raised timeout or a retry: there is no longer anything to time out on.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import type { Express } from "express";

export interface InvokeOptions {
  method?: string;
  url: string;
  /** Sent as JSON when present. `content-type`/`content-length` are set for you. */
  json?: unknown;
  /** Extra request headers. Keys are lower-cased, as Node's parser would deliver them. */
  headers?: Record<string, string>;
}

export interface InvokeResult {
  status: number;
  /**
   * Headers the app set, lower-cased. Node's implicit framing headers
   * (`Transfer-Encoding`, `Date`, `Connection`) are not among them.
   */
  headers: Record<string, string>;
  text: string;
  /** Parsed JSON body, or `undefined` when the body is empty or not JSON. */
  body: unknown;
}

/**
 * Status and headers come from the `ServerResponse` API rather than from re-parsing the
 * status line — Node already holds them structurally, and a second parser would only add
 * branches that Node's own serializer can never take. Only the BODY has to be recovered
 * from the wire bytes, by skipping the header block.
 */
function extractBody(raw: Buffer, chunked: boolean): string {
  const separator = raw.indexOf("\r\n\r\n");
  const bodyBuf = separator === -1 ? Buffer.alloc(0) : raw.subarray(separator + 4);
  return (chunked ? decodeChunked(bodyBuf) : bodyBuf).toString("utf8");
}

/**
 * A handler that writes without setting `Content-Length` gets chunked framing from Node,
 * so the sizes have to be stripped back off. `res.json()` always sets a length, but
 * `res.write(...)` before `res.end()` does not.
 */
function decodeChunked(buf: Buffer): Buffer {
  const out: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = buf.indexOf("\r\n", offset);
    if (lineEnd === -1) break;
    const size = Number.parseInt(buf.subarray(offset, lineEnd).toString("latin1"), 16);
    if (!Number.isInteger(size) || size === 0) break;
    out.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(out);
}

/**
 * Hand one request to `app` in-process and resolve with the response it serialized.
 *
 * Deliberately has no timer of its own: a handler that never responds must still fail
 * the test (via vitest's `testTimeout`), because that is a real bug rather than a busy
 * machine.
 */
export function invoke(app: Express, options: InvokeOptions): Promise<InvokeResult> {
  const { method = "GET", url, json, headers = {} } = options;
  const payload = json === undefined ? undefined : Buffer.from(JSON.stringify(json), "utf8");

  // `new PassThrough()` allocates no file descriptor — it is the whole point.
  const socket = new PassThrough();
  const req = new IncomingMessage(
    socket as unknown as ConstructorParameters<typeof IncomingMessage>[0],
  );
  req.method = method.toUpperCase();
  req.url = url;
  req.httpVersion = "1.1";
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.headers = {
    host: "127.0.0.1",
    ...(payload
      ? { "content-type": "application/json", "content-length": String(payload.byteLength) }
      : {}),
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  };

  const res = new ServerResponse(req);
  const wire = new PassThrough();
  const chunks: Buffer[] = [];
  wire.on("data", (c: Buffer) => chunks.push(c));
  res.assignSocket(wire as unknown as Parameters<ServerResponse["assignSocket"]>[0]);

  return new Promise<InvokeResult>((resolve) => {
    res.on("finish", () => {
      // `finish` fires once the last write has been handed to the socket; let the
      // PassThrough drain it before reading the bytes back.
      setImmediate(() => {
        const responseHeaders = Object.fromEntries(
          Object.entries(res.getHeaders()).map(([k, v]) => [k, String(v)]),
        );
        // `Transfer-Encoding` is chosen by Node's serializer and never appears in
        // `getHeaders()`, so the framing flag is the only honest source for it.
        const text = extractBody(Buffer.concat(chunks), res.chunkedEncoding);
        resolve({
          status: res.statusCode,
          headers: responseHeaders,
          text,
          body:
            text.length > 0 && responseHeaders["content-type"]?.includes("json")
              ? (JSON.parse(text) as unknown)
              : undefined,
        });
      });
    });

    app(req, res);
    if (payload) req.push(payload);
    req.push(null);
  });
}
