/**
 * #1458 — every request-body parser the API installs, built in one place so none of
 * them can decompress a request body.
 *
 * body-parser 2.2.2 (via express 5.2.1) carried GHSA-27r3-jxmh-p828 (high): a
 * Denial of Service through trailing bytes after a *compressed* request body. #1458
 * closed that path here while the fix, 2.4.0, served out the 7-day pnpm
 * `minimumReleaseAge`; #1460 has since upgraded to 2.4.0 (a `pnpm-workspace.yaml`
 * override). `inflate: false` stays as the default anyway: no METIS client or
 * integration sends a compressed body (browsers via the Next.js proxy, GitHub /
 * Slack / Bot Framework / trigger webhooks, SCIM — all uncompressed; MCP is
 * stdio-only), so decompression is attack surface with no user. body-parser refuses
 * any non-`identity` encoding with a 415 (`encoding.unsupported`) before a zlib
 * stream exists, and the error handler maps that to `UNSUPPORTED_CONTENT_ENCODING`.
 *
 * Construct parsers through these helpers only — the guard test
 * `body-parsers.inflate.test.ts` fails on a direct `express.json()` /
 * `urlencoded()` / `raw()` / `text()` call anywhere else in `server/src`, under any
 * import name.
 *
 * The one other body-parser consumer is the embeddings sidecar
 * (`server/embeddings-svc/src/app.ts`), a separate package that cannot import this
 * module: its single `express.json()` passes `inflate: false` itself, and the same
 * guard test fails if any parser there omits it.
 */
import express from "express";

type JsonOptions = NonNullable<Parameters<typeof express.json>[0]>;
type UrlencodedOptions = NonNullable<Parameters<typeof express.urlencoded>[0]>;
/** body-parser's own handler type (its `next` takes an error), as `express.json()` returns it. */
type BodyParser = ReturnType<typeof express.json>;

/** A JSON body parser that refuses compressed bodies with 415. */
export function jsonBodyParser(options: Omit<JsonOptions, "inflate"> = {}): BodyParser {
  return express.json({ ...options, inflate: false });
}

/** A urlencoded body parser that refuses compressed bodies with 415. */
export function urlencodedBodyParser(options: Omit<UrlencodedOptions, "inflate"> = {}): BodyParser {
  return express.urlencoded({ ...options, inflate: false });
}
