/**
 * #297 — find Playwright `route()` calls in the e2e suite that pass a `times`
 * option.
 *
 * A `{ times: N }` route removes itself after N matches. When it was the last
 * route, Playwright turns Chromium's request interception off, and a request the
 * page starts in that instant is left paused and never reaches the server: the
 * quarantine list refresh hung that way. Measured with a follow-up request
 * started as the routed one settles: 24 of 200 hung with `times: 1` on
 * playwright-core 1.59.1 and 6 of 200 on 1.63.0; 0 of 200 on either with a route
 * that stays registered and passes later requests on. This scanner finds the
 * option so the suite cannot reintroduce it.
 */

/**
 * `src` with the bodies of strings, template literals and comments replaced by
 * spaces (newlines kept), so offsets and line numbers still line up and nothing
 * inside a literal or a comment can look like code.
 *
 * @param {string} src
 */
export function blankLiterals(src) {
  const out = src.split("");
  const blank = (/** @type {number} */ from, /** @type {number} */ to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? src.length : nl;
      blank(i, end);
      i = end;
    } else if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close === -1 ? src.length : close + 2;
      blank(i, end);
      i = end - 1;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(j, src.length));
      i = j;
    }
  }
  return out.join("");
}

/**
 * The index just past the call whose `(` is at `open` in literal-free `code`,
 * or -1 when the code ends first.
 *
 * @param {string} code
 * @param {number} open
 */
export function callEnd(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * 1-based line numbers of every `.route(` call in `src` whose arguments set a
 * `times` option.
 *
 * @param {string} src
 * @returns {number[]}
 */
export function routeCallsWithTimes(src) {
  const code = blankLiterals(src);
  /** @type {number[]} */
  const lines = [];
  const re = /\.route\s*\(/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const open = m.index + m[0].length - 1;
    const end = callEnd(code, open);
    const args = code.slice(open, end === -1 ? code.length : end);
    if (/\btimes\s*:/.test(args)) lines.push(code.slice(0, m.index).split("\n").length);
  }
  return lines;
}
