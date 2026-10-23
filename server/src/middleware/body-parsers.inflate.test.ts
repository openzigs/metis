/**
 * #1458 — body-parser GHSA-27r3-jxmh-p828: no request-body parser may inflate a
 * compressed body. Unit arm (the helpers against a bare Express app, with the real
 * error handler) and inventory arm (no parser in `server/src` bypasses the helpers).
 * The whole-app arm, through `createApp()`, is `server/tests/body-parser-inflate-1458.test.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import express, { type RequestHandler } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonBodyParser, urlencodedBodyParser } from "./body-parsers.js";
import { errorHandler } from "./error-handler.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A bare app: the parser under test, an echo route that records it was reached, the real error handler. */
function appWith(parser: RequestHandler) {
  const reached = vi.fn();
  const app = express();
  app.use(parser);
  app.post("/echo", (req, res) => {
    reached(req.body);
    res.json({ body: req.body });
  });
  app.use(errorHandler);
  return { app, reached };
}

/**
 * superagent JSON-serialises a Buffer sent as `application/json` (`{"type":"Buffer",...}`);
 * this sends the compressed bytes verbatim instead.
 */
const raw = (body: unknown) => body as string;

const JSON_BODY = JSON.stringify({ hello: "world" });
const FORM_BODY = "hello=world";

const ENCODINGS: Array<[string, (b: Buffer) => Buffer]> = [
  ["gzip", (b) => zlib.gzipSync(b)],
  ["deflate", (b) => zlib.deflateSync(b)],
  ["br", (b) => zlib.brotliCompressSync(b)],
];

/** Spies on every inflater body-parser can construct — they must never be called. */
function spyOnInflaters() {
  return [
    vi.spyOn(zlib, "createGunzip"),
    vi.spyOn(zlib, "createInflate"),
    vi.spyOn(zlib, "createBrotliDecompress"),
  ];
}

describe("jsonBodyParser refuses compressed request bodies (#1458)", () => {
  for (const [encoding, compress] of ENCODINGS) {
    it(`refuses a ${encoding} JSON body with 415 before any inflater exists`, async () => {
      const inflaters = spyOnInflaters();
      const { app, reached } = appWith(jsonBodyParser());
      const res = await request(app)
        .post("/echo")
        .set("Content-Type", "application/json")
        .set("Content-Encoding", encoding)
        .serialize(raw)
        .send(compress(Buffer.from(JSON_BODY)));
      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe("UNSUPPORTED_CONTENT_ENCODING");
      expect(reached).not.toHaveBeenCalled();
      for (const spy of inflaters) expect(spy).not.toHaveBeenCalled();
    });
  }

  it("refuses a gzip body with trailing bytes (the advisory's shape) the same way", async () => {
    const { app, reached } = appWith(jsonBodyParser());
    const body = Buffer.concat([zlib.gzipSync(Buffer.from(JSON_BODY)), Buffer.alloc(4096, 0x41)]);
    const res = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .serialize(raw)
      .send(body);
    expect(res.status).toBe(415);
    expect(reached).not.toHaveBeenCalled();
  });

  it("still parses an uncompressed body, with or without an explicit identity encoding", async () => {
    const { app, reached } = appWith(jsonBodyParser());
    const plain = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(JSON_BODY);
    expect(plain.status).toBe(200);
    expect(plain.body.body).toEqual({ hello: "world" });

    const identity = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "identity")
      .send(JSON_BODY);
    expect(identity.status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(2);
  });

  it("keeps the caller's options (limit) while forcing inflate off", async () => {
    const { app } = appWith(jsonBodyParser({ limit: 10 }));
    const res = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(JSON_BODY);
    expect(res.status).toBe(413);
  });

  it("cannot be talked back into inflating by an untyped `inflate: true`", async () => {
    // The Omit<> blocks it at compile time; this proves the spread order at runtime.
    const { app } = appWith(jsonBodyParser({ inflate: true } as never));
    const res = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .serialize(raw)
      .send(zlib.gzipSync(Buffer.from(JSON_BODY)));
    expect(res.status).toBe(415);
  });

  it("control: a default express.json() DOES inflate — the refusal above is the option, not the transport", async () => {
    const inflaters = spyOnInflaters();
    const { app } = appWith(express.json());
    const res = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .serialize(raw)
      .send(zlib.gzipSync(Buffer.from(JSON_BODY)));
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ hello: "world" });
    expect(inflaters[0]).toHaveBeenCalled();
  });
});

describe("urlencodedBodyParser refuses compressed request bodies (#1458)", () => {
  it("refuses a gzip form body with 415 and never reaches the route", async () => {
    const inflaters = spyOnInflaters();
    const { app, reached } = appWith(urlencodedBodyParser({ extended: true }));
    const res = await request(app)
      .post("/echo")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .set("Content-Encoding", "gzip")
      .serialize(raw)
      .send(zlib.gzipSync(Buffer.from(FORM_BODY)));
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe("UNSUPPORTED_CONTENT_ENCODING");
    expect(reached).not.toHaveBeenCalled();
    for (const spy of inflaters) expect(spy).not.toHaveBeenCalled();
  });

  it("still parses an uncompressed form body", async () => {
    const { app } = appWith(urlencodedBodyParser({ extended: true }));
    const res = await request(app)
      .post("/echo")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(FORM_BODY);
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ hello: "world" });
  });
});

describe("every body parser in server/src goes through the inflate-off helpers (#1458)", () => {
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const HELPER = join("middleware", "body-parsers.ts");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
    });
  }

  // `express.json(`, `bodyParser.raw(`, or a bare `json(` / `urlencoded(` / `raw(` /
  // `text(` imported from express or body-parser. `res.json(` is a response, not a parser.
  const DIRECT_PARSER = /\b(?:express|bodyParser)\.(?:json|urlencoded|raw|text)\s*\(/;
  const PARSER_IMPORT =
    /import\s*\{[^}]*\b(?:json|urlencoded|raw|text)\b[^}]*\}\s*from\s*["'](?:express|body-parser)["']/;
  const BODY_PARSER_IMPORT = /from\s*["']body-parser["']|require\(\s*["']body-parser["']\s*\)/;

  /** Comments name `express.json()` freely; only code may construct a parser. */
  function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  it("finds the parsers it is meant to police (the scan is not vacuous)", () => {
    const helper = stripComments(readFileSync(join(SRC, HELPER), "utf8"));
    expect(helper).toMatch(DIRECT_PARSER);
    expect(helper).toMatch(/inflate:\s*false/);
  });

  it("has no direct parser construction outside middleware/body-parsers.ts", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => relative(SRC, file) !== HELPER)
      .filter((file) => {
        const text = stripComments(readFileSync(file, "utf8"));
        return (
          DIRECT_PARSER.test(text) || PARSER_IMPORT.test(text) || BODY_PARSER_IMPORT.test(text)
        );
      })
      .map((file) => relative(SRC, file));
    expect(offenders, "build body parsers with jsonBodyParser / urlencodedBodyParser").toEqual([]);
  });
});
