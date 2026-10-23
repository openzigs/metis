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

describe("no body parser in server/src or the embeddings sidecar can inflate (#1458)", () => {
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const SIDECAR_SRC = resolve(SRC, "..", "embeddings-svc", "src");
  const HELPER = join("middleware", "body-parsers.ts");
  const PARSER_KINDS = ["json", "urlencoded", "raw", "text"];
  const PARSER_MODULE = String.raw`["'](?:express|body-parser)["']`;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
    });
  }

  /** Comments name `express.json()` freely; only code may construct a parser. */
  function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  /** The argument text of the call whose `(` is at `open`, by paren matching. */
  function callArgs(text: string, open: number): string {
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")" && (depth -= 1) === 0) return text.slice(open + 1, i);
    }
    return text.slice(open + 1);
  }

  /**
   * Every body-parser construction in `text`, whatever the local names: a default or
   * namespace import of express / body-parser under any name (`import e from "express";
   * e.json()`), a `require`, or a named import, aliased or not (`{ json as j }`).
   * `res.json(` is a response method, not a parser, and never matches.
   */
  function parserCalls(source: string): Array<{ call: string; args: string }> {
    const text = stripComments(source);
    const objects = new Set<string>();
    const functions = new Set<string>();
    const add = (re: RegExp, into: Set<string>) => {
      for (const m of text.matchAll(re)) into.add(m[1]);
    };
    add(
      new RegExp(String.raw`import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*${PARSER_MODULE}`, "g"),
      objects,
    );
    add(new RegExp(String.raw`import\s*\*\s*as\s+(\w+)\s+from\s*${PARSER_MODULE}`, "g"), objects);
    add(
      new RegExp(
        String.raw`(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*${PARSER_MODULE}\s*\)`,
        "g",
      ),
      objects,
    );
    for (const m of text.matchAll(
      new RegExp(String.raw`import\s*(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*${PARSER_MODULE}`, "g"),
    )) {
      for (const spec of m[1].split(",")) {
        const [imported, local] = spec
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/);
        if (PARSER_KINDS.includes(imported)) functions.add(local ?? imported);
      }
    }
    // One literal pattern for every `name(` / `name.member(` call, filtered against the
    // resolved names in code (a regex built from an identifier is a Semgrep finding).
    // The lookbehind keeps `res.json(` from matching as a bare `json(`.
    const calls: Array<{ call: string; args: string }> = [];
    for (const m of text.matchAll(/(?<![.\w])(\w+)(?:\s*\.\s*(\w+))?\s*\(/g)) {
      const [whole, head, member] = m;
      const isParser =
        member === undefined
          ? functions.has(head)
          : objects.has(head) && PARSER_KINDS.includes(member);
      if (!isParser) continue;
      const open = (m.index ?? 0) + whole.length - 1;
      calls.push({ call: whole, args: callArgs(text, open) });
    }
    return calls;
  }

  const inflateOff = (args: string) => /\binflate\s*:\s*false\b/.test(args);

  it("detects renamed and aliased parser imports, and ignores res.json()", () => {
    expect(parserCalls('import e from "express";\nconst p = e.json({ limit: 1 });')).toHaveLength(
      1,
    );
    expect(parserCalls('import * as bp from "body-parser";\nbp.raw();')).toHaveLength(1);
    expect(parserCalls('const x = require("express");\nx.urlencoded({});')).toHaveLength(1);
    expect(
      parserCalls('import { Router, json as j, text } from "express";\nj({});\ntext();'),
    ).toHaveLength(2);
    expect(parserCalls('import express from "express";\nres.json({ ok: true });')).toEqual([]);
    expect(parserCalls('// express.json()\nimport express from "express";')).toEqual([]);
    const [call] = parserCalls(
      'import ex from "express";\nex.json({ limit: f(1), inflate: false });',
    );
    expect(inflateOff(call.args)).toBe(true);
  });

  it("finds the parsers it is meant to police (the scan is not vacuous)", () => {
    const helper = parserCalls(readFileSync(join(SRC, HELPER), "utf8"));
    expect(helper).toHaveLength(2);
    expect(helper.every((c) => inflateOff(c.args))).toBe(true);
    const sidecar = sourceFiles(SIDECAR_SRC).flatMap((f) => parserCalls(readFileSync(f, "utf8")));
    expect(sidecar.length, "the embeddings sidecar's parser was not found").toBeGreaterThan(0);
  });

  it("server/src has no parser construction outside middleware/body-parsers.ts", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => relative(SRC, file) !== HELPER)
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return parserCalls(text).length > 0 || /from\s*["']body-parser["']/.test(text);
      })
      .map((file) => relative(SRC, file));
    expect(offenders, "build body parsers with jsonBodyParser / urlencodedBodyParser").toEqual([]);
  });

  it("every parser in the embeddings sidecar (server/embeddings-svc/src) passes inflate: false", () => {
    // The sidecar is its own package and cannot import the server's helper.
    const offenders = sourceFiles(SIDECAR_SRC).flatMap((file) =>
      parserCalls(readFileSync(file, "utf8"))
        .filter((c) => !inflateOff(c.args))
        .map((c) => `${relative(SIDECAR_SRC, file)}: ${c.call}${c.args})`),
    );
    expect(offenders).toEqual([]);
  });
});
