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
 *
 * Scope: only `times`. An explicit `unroute` / `unrouteAll` can also remove the
 * last route, but it runs at a point the test chose rather than on whichever
 * request happens to be the Nth, and no flake has been traced to one; the
 * remaining call sites are tracked in #327 instead of being banned
 * here unmeasured.
 *
 * The source is parsed with the TypeScript compiler, not scanned by hand: a
 * character loop that blanks strings and comments cannot tell a regex literal
 * from a division, so one quote inside `/.../` hid every later call in the file.
 */
import ts from "typescript";

/**
 * Whether an object literal sets `times`, as `times: n`, `"times": n` or the
 * `{ times }` shorthand.
 *
 * @param {ts.ObjectLiteralExpression} obj
 */
function setsTimes(obj) {
  return obj.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === "times",
  );
}

/**
 * 1-based line numbers of every `.route(` call in `src` whose arguments set a
 * `times` option in an object literal.
 *
 * @param {string} src
 * @param {string} [fileName] only its extension matters (`.tsx` enables JSX).
 * @returns {number[]}
 */
export function routeCallsWithTimes(src, fileName = "spec.ts") {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
  /** @type {number[]} */
  const lines = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "route" &&
      node.arguments.some((a) => ts.isObjectLiteralExpression(a) && setsTimes(a))
    ) {
      const at = node.expression.name.getStart(sf);
      lines.push(sf.getLineAndCharacterOfPosition(at).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}
