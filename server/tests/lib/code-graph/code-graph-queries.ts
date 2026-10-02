/**
 * Issue #698 — typed seam onto the code-graph MCP wrapper's query functions.
 *
 * The queries live in `images/mcp-wrappers/code-graph-runner-sse/queries/`, a
 * separate package that compiles against its OWN pinned `zod` (3.x) and its own
 * `@prisma/client` generated from its own `prisma/schema.prisma`. The server
 * workspace installs neither, so a static import here would drag those sources into
 * server's type-check, where `zod` / `@prisma/client` cannot resolve (TS2307) — and
 * mapping them onto server's zod 4 / Prisma 7 would type-check the image against
 * dependencies it never ships with.
 *
 * So the modules load through a computed specifier, which `tsc` does not follow,
 * and are typed by the contract below: the shapes the image exports, restated.
 * At runtime vitest transforms and runs the real image sources exactly as before.
 */

import { fileURLToPath } from "node:url";

/** Absolute, because the module runner cannot resolve a relative computed specifier. */
const QUERIES_DIR = fileURLToPath(
  new URL("../../../../images/mcp-wrappers/code-graph-runner-sse/queries/", import.meta.url),
);

/** Every query takes a Prisma-shaped client and unvalidated input it parses itself. */
type CodeGraphQuery<Result> = (prisma: unknown, rawInput: unknown) => Promise<Result>;

/** `get_call_graph.ts` → `GetCallGraphResult`. */
export interface GetCallGraphResult {
  nodes: { qualifiedName: string; kind: string; filePath: string; startLine: number }[];
  edges: { from: string; to: string; kind: string; line: number }[];
  truncated: boolean;
}

/** `who_calls.ts` → `WhoCallsResult`. */
export interface WhoCallsResult {
  callers: { filePath: string; line: number; callerSymbol: string }[];
  nextCursor: string | null;
}

/** `defined_in.ts` → `DefinedInResult`. */
export type DefinedInResult = { filePath: string; line: number } | null;

/** `imports_of.ts` → `ImportsOfResult`. */
export interface ImportEdgeView {
  fromFile: string;
  toQualifiedName: string;
  line: number;
  typeOnly: boolean;
}
export interface ImportsOfResult {
  outbound: ImportEdgeView[];
  inbound: ImportEdgeView[];
}

/** `outline.ts` → `OutlineResult`. */
export type OutlineResult = { name: string; kind: string; qualifiedName: string; line: number }[];

async function load<Result>(file: string, exportName: string): Promise<CodeGraphQuery<Result>> {
  // Computed on purpose: a literal specifier would make tsc compile the image's sources.
  const mod: Record<string, unknown> = await import(QUERIES_DIR + file);
  const fn = mod[exportName];
  if (typeof fn !== "function") throw new Error(`${file} does not export ${exportName}()`);
  // Boundary cast: the image package is type-checked by its own tsconfig, not this one.
  return fn as CodeGraphQuery<Result>;
}

export const getCallGraph = await load<GetCallGraphResult>("get_call_graph.ts", "getCallGraph");
export const whoCalls = await load<WhoCallsResult>("who_calls.ts", "whoCalls");
export const definedIn = await load<DefinedInResult>("defined_in.ts", "definedIn");
export const importsOf = await load<ImportsOfResult>("imports_of.ts", "importsOf");
export const outline = await load<OutlineResult>("outline.ts", "outline");
