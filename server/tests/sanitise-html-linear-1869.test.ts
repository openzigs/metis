/**
 * #1869 — `sanitiseHtml` in linear time, with output unchanged.
 *
 * The governing-document upload parses a file inside the HTTP request, and
 * CodeQL (js/polynomial-redos) traced the uploaded bytes into this function. The
 * regexes it used retried from every opener when no closer followed. The
 * previous implementation is the reference (`fixtures/sanitise-html-reference-1869.ts`):
 * on ordinary and on randomly built HTML the new one must give the same output,
 * and on the inputs that were quadratic it must finish in a bounded time. The
 * one intended difference: a comment also ends at `--!>`, as HTML parsers end it.
 */
import { describe, expect, it } from "vitest";
import { sanitiseHtml } from "../src/lib/documents/parsers.js";
import { referenceSanitiseHtml } from "./fixtures/sanitise-html-reference-1869.js";

const FRAGMENTS = [
  "<!--",
  "-->",
  "-",
  "<script>",
  "<SCRIPT type='x'>",
  "</script>",
  "</script >",
  "<scripts>",
  "<style>",
  "</style>",
  "<iframe src=x>",
  "</iframe>",
  "<object>",
  "</object  >",
  "<embed src='y'/>",
  "<embed",
  "<noscript>",
  "</noscript>",
  "<p>",
  "</p>",
  "<br>",
  "<br/>",
  "<>",
  "<",
  ">",
  " ",
  "  ",
  "\t",
  "\n",
  ' onclick="a()"',
  " onx='b'",
  " onload=c",
  " on",
  "=",
  '"',
  "'",
  ' href="javascript:x"',
  " src='data:y'",
  "&amp;lt;",
  "&nbsp;",
  "text",
  "a",
];

/** A deterministic PRNG, so a failure names a reproducible case. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("sanitiseHtml (#1869)", () => {
  it("gives the reference output on ordinary HTML", () => {
    const docs = [
      "<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Policy</h1><p>Passwords rotate <b>every</b> 90 days.</p><!-- note --><ul><li>a</li><li>b</li></ul></body></html>",
      '<div onclick="x()" class="c"><a href="javascript:evil()">link</a> <img src=\'data:abc\' onerror=bad></div>',
      "<p>1 &lt; 2 &amp; 3 &gt; 0</p><br><br/><table><tr><td>x</td></tr></table>",
      "<iframe src='evil'></iframe><object>x</object><embed src='y'/><noscript>n</noscript>tail",
      "unclosed <!-- comment and <script> and <a tag",
    ];
    for (const doc of docs) expect(sanitiseHtml(doc)).toBe(referenceSanitiseHtml(doc));
  });

  it("ends a comment at --!> as well as -->", () => {
    expect(sanitiseHtml("a<!-- hidden --!>b")).toBe("ab");
    expect(sanitiseHtml("a<!-- hidden -->b")).toBe("ab");
  });

  it("gives the reference output on 3,000 randomly built inputs", () => {
    const rand = lcg(1869);
    for (let n = 0; n < 3000; n += 1) {
      const len = 1 + Math.floor(rand() * 24);
      let doc = "";
      for (let i = 0; i < len; i += 1) doc += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
      expect(sanitiseHtml(doc), JSON.stringify(doc)).toBe(referenceSanitiseHtml(doc));
    }
  });

  it("finishes in bounded time on the inputs that were quadratic", () => {
    const size = 1_000_000;
    const inputs = {
      comments: "<!--".repeat(size / 4),
      scripts: "<script ".repeat(size / 8),
      embeds: "<embed ".repeat(size / 7),
      spaces: " ".repeat(size),
      openers: "<".repeat(size),
      handlers: ` on${" ".repeat(size)}`,
    };
    for (const [name, input] of Object.entries(inputs)) {
      const started = performance.now();
      sanitiseHtml(input);
      const ms = performance.now() - started;
      // The previous implementation took 14-22 s on a FIFTH of this size.
      expect(ms, name).toBeLessThan(2_000);
    }
  });
});
