/**
 * #297 / #327 — find Playwright calls in the e2e suite that can remove the last
 * route mid-test: `route()` with a `times` option, and `unroute` / `unrouteAll`.
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
 * #327 — an explicit `unroute` / `unrouteAll` that removes the last route
 * switches interception off the same way and strands requests the same way.
 * Measured on playwright-core 1.63.0 (Chromium, local HTTP server, 200
 * iterations per row, one counted as hung if any request is still unanswered
 * after 5 s), with the page keeping four fetches in flight while the test
 * removes its only route:
 * `page.unroute` 33/200, `context.unroute` 24/200, `unrouteAll({ behavior:
 * "wait" })` 48/200, `unrouteAll({ behavior: "ignoreErrors" })` 44/200. The
 * same harness with the route left registered and disarmed by a flag
 * (`route.fallback()`): 0/200 on page and 0/200 on context. With a single
 * follow-up fetch fired as a routed one settles, `unrouteAll({ behavior:
 * "wait" })` hung 3/200. The host's load average was 40–70 during these runs,
 * so treat the counts as indicative. `unrouteCalls` finds both methods, so a
 * spec keeps its route registered and disarms it with a flag instead. There is
 * deliberately no allowlist or comment-based bypass: even a teardown `unroute`
 * can strand a request, and keeping the route and disarming it is the only fix.
 *
 * #539 — `getByRole("heading", { name: "<literal>" })` without `exact: true`
 * matches any heading that merely CONTAINS the literal, case-insensitively. It
 * passes until the page also renders a heading such as "Unlinked connections"
 * next to "Connections", and from then on it resolves to two elements or to
 * whichever renders first: the #306 flake. `nonExactHeadingNames` finds every
 * literal-named heading locator that is not exact. A regex or computed name is
 * left alone: a regex states its own anchoring, and a computed name is not a
 * literal the scanner can reason about.
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
 * 1-based line numbers of every `x.<method>(...)` call in `src` for which
 * `matches` holds.
 *
 * @param {string} src
 * @param {string} fileName only its extension matters (`.tsx` enables JSX).
 * @param {(call: ts.CallExpression & { expression: ts.PropertyAccessExpression }) => boolean} matches
 * @returns {number[]}
 */
function methodCallLines(src, fileName, matches) {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
  /** @type {number[]} */
  const lines = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      matches(/** @type {any} */ (node))
    ) {
      const at = node.expression.name.getStart(sf);
      lines.push(sf.getLineAndCharacterOfPosition(at).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
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
  return methodCallLines(
    src,
    fileName,
    (call) =>
      call.expression.name.text === "route" &&
      call.arguments.some((a) => ts.isObjectLiteralExpression(a) && setsTimes(a)),
  );
}

const REMOVERS = new Set(["unroute", "unrouteAll"]);

/**
 * 1-based line numbers of every `.unroute(` and `.unrouteAll(` call in `src`.
 * Either can remove the last route, which switches Chromium's request
 * interception off and can strand a request the page starts at that instant.
 *
 * @param {string} src
 * @param {string} [fileName] only its extension matters (`.tsx` enables JSX).
 * @returns {number[]}
 */
export function unrouteCalls(src, fileName = "spec.ts") {
  return methodCallLines(src, fileName, (call) => REMOVERS.has(call.expression.name.text));
}

/**
 * The initializer of the property called `key` in an object literal, whether
 * written `key: v` or `"key": v`; undefined when absent or not a plain assignment.
 *
 * @param {ts.ObjectLiteralExpression} obj
 * @param {string} key
 * @returns {ts.Expression | undefined}
 */
function propertyValue(obj, key) {
  for (const p of obj.properties) {
    if (
      ts.isPropertyAssignment(p) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === key
    ) {
      return p.initializer;
    }
  }
  return undefined;
}

/** @param {ts.Node | undefined} node */
const isStringLiteralLike = (node) =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

/**
 * 1-based line numbers of every `x.getByRole("heading", { name: "<literal>" })`
 * in `src` whose options do not set `exact: true`.
 *
 * @param {string} src
 * @param {string} [fileName] only its extension matters (`.tsx` enables JSX).
 * @returns {number[]}
 */
export function nonExactHeadingNames(src, fileName = "spec.ts") {
  return methodCallLines(src, fileName, (call) => {
    const [role, options] = call.arguments;
    if (call.expression.name.text !== "getByRole") return false;
    if (!isStringLiteralLike(role) || /** @type {ts.StringLiteral} */ (role).text !== "heading") {
      return false;
    }
    if (options === undefined || !ts.isObjectLiteralExpression(options)) return false;
    if (!isStringLiteralLike(propertyValue(options, "name"))) return false;
    return propertyValue(options, "exact")?.kind !== ts.SyntaxKind.TrueKeyword;
  });
}
