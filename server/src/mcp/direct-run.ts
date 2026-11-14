/**
 * Whether `argv1` (`process.argv[1]`) is the MCP server `server`'s own entry
 * script, `…/mcp/<server>/server.{js,ts}`, so the module boots on stdio only
 * when node was asked to run it — not when a test or another module imports it.
 *
 * #2331 — matched on either path separator: on Windows `argv[1]` is
 * `C:\…\mcp\metis-index\server.js`, and a forward-slash-only match left the
 * process to exit silently, which a client reports only as a server that would
 * not start. Matched on the path's tail rather than compared with
 * `import.meta.url`, which can differ from `argv[1]` when the script is reached
 * through a symlink.
 */
export function isDirectRun(argv1: string | undefined, server: "metis-index" | "speckit"): boolean {
  if (argv1 === undefined) return false;
  return new RegExp(`mcp[\\\\/]${server}[\\\\/]server\\.(?:js|ts)$`).test(argv1);
}
