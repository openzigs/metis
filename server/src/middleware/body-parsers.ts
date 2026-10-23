/**
 * #1458 — every request-body parser the API installs, built in one place so none of
 * them can decompress a request body.
 *
 * body-parser 2.2.2 (via express 5.2.1) carries GHSA-27r3-jxmh-p828 (high): a
 * Denial of Service through trailing bytes after a *compressed* request body. The
 * fix, 2.4.0, is held back by the 7-day pnpm `minimumReleaseAge` until 2026-10-29.
 * The vulnerable code runs only when the parser inflates a `Content-Encoding:
 * gzip | deflate | br` body. No METIS client or integration sends one (browsers via
 * the Next.js proxy, GitHub / Slack / Bot Framework / trigger webhooks, SCIM — all
 * uncompressed; MCP is stdio-only), so with `inflate: false` body-parser refuses any
 * non-`identity` encoding with a 415 (`encoding.unsupported`) before a zlib stream
 * exists. The error handler maps that to `UNSUPPORTED_CONTENT_ENCODING`.
 *
 * Construct parsers through these helpers only — the guard test
 * `body-parsers.inflate.test.ts` fails on a direct `express.json()` /
 * `urlencoded()` / `raw()` / `text()` call anywhere else in `server/src`.
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
