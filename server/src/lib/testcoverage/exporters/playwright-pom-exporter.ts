/**
 * Playwright Page-Object-Model scaffold exporter (Epic #260, issue #44).
 *
 * Converts an array of `ExportableSuggestion` into an in-memory zip containing:
 *   - `pages/<Feature>Page.ts`  — one Page Object class per feature/requirement
 *     group, with a navigation stub + a placeholder action per suggestion.
 *   - `tests/<feature>.spec.ts` — one spec file per feature group, with one
 *     `test.skip(...)` per suggestion so the suite *lists* (passes
 *     `npx playwright test --list`) but never executes a real browser.
 *   - `playwright.config.ts`    — a minimal config snippet pointing at `tests/`.
 *
 * SECURITY (#44): every attacker-controlled value (suggestion title, gwt step
 * text, feature/selector names) is treated as untrusted. We NEVER interpolate
 * raw strings into generated TypeScript. Instead:
 *   - identifiers are derived via {@link toPascalIdentifier} / {@link toSafeSlug}
 *     (alphanumeric only — no quotes, backticks, `${`, path separators, `..`);
 *   - any value that must appear as source *content* is emitted through
 *     {@link tsStringLiteral}, which JSON-encodes the string so quotes,
 *     backticks, `${`, backslashes and newlines cannot break out of the
 *     literal, and through {@link safeComment} for comment lines.
 *   - all files are written to an in-memory JSZip — no attacker-controlled
 *     filename ever touches the real filesystem (avoids path traversal).
 */
import JSZip from "jszip";

import type { ExportableSuggestion } from "./types.js";

export interface PlaywrightPomExportResult {
  readonly kind: "zip";
  readonly filename: string;
  readonly data: Buffer;
  readonly files: ReadonlyArray<{ filename: string; text: string }>;
}

export interface PlaywrightPomExportOptions {
  readonly defaultFeatureName?: string;
}

const FEATURE_TAG_PREFIX = "feature:";

export async function exportSuggestionsToPlaywrightPom(
  suggestions: ReadonlyArray<ExportableSuggestion>,
  opts: PlaywrightPomExportOptions = {},
): Promise<PlaywrightPomExportResult> {
  const defaultName = opts.defaultFeatureName ?? "Generated Suite";
  const groups = groupByFeature(suggestions, defaultName);

  const files: { filename: string; text: string }[] = [];
  const usedPageNames = new Set<string>();
  const usedSpecNames = new Set<string>();

  for (const [feature, items] of groups.entries()) {
    const className = uniqueName(`${toPascalIdentifier(feature)}Page`, usedPageNames);
    const specSlug = uniqueName(toSafeSlug(feature), usedSpecNames);
    files.push({
      filename: `pages/${className}.ts`,
      text: renderPageObject(className, feature, items),
    });
    files.push({
      filename: `tests/${specSlug}.spec.ts`,
      text: renderSpec(className, feature, items),
    });
  }

  files.push({ filename: "playwright.config.ts", text: renderConfig() });

  const zip = new JSZip();
  for (const f of files) zip.file(f.filename, f.text);
  const data = await zip.generateAsync({ type: "nodebuffer" });
  return { kind: "zip", filename: "playwright-pom-scaffold.zip", data, files };
}

// ---- grouping -------------------------------------------------------------

function groupByFeature(
  suggestions: ReadonlyArray<ExportableSuggestion>,
  defaultFeature: string,
): Map<string, ExportableSuggestion[]> {
  const out = new Map<string, ExportableSuggestion[]>();
  for (const s of suggestions) {
    const featureTag = (s.tags ?? []).find((t) => t.startsWith(FEATURE_TAG_PREFIX));
    const feature = featureTag ? featureTag.slice(FEATURE_TAG_PREFIX.length) : defaultFeature;
    const list = out.get(feature) ?? [];
    list.push(s);
    out.set(feature, list);
  }
  return out;
}

// ---- rendering ------------------------------------------------------------

function renderPageObject(
  className: string,
  feature: string,
  items: ReadonlyArray<ExportableSuggestion>,
): string {
  const lines: string[] = [];
  lines.push(`import { type Page, type Locator } from "@playwright/test";`);
  lines.push("");
  lines.push(`${safeComment(`Page Object for feature: ${feature}`)}`);
  lines.push(`export class ${className} {`);
  lines.push(`  readonly page: Page;`);
  lines.push(`  readonly root: Locator;`);
  lines.push("");
  lines.push(`  constructor(page: Page) {`);
  lines.push(`    this.page = page;`);
  lines.push(`    this.root = page.locator("body");`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async goto(path: string = "/"): Promise<void> {`);
  lines.push(`    await this.page.goto(path);`);
  lines.push(`  }`);

  const usedMethods = new Set<string>(["goto", "constructor"]);
  for (const s of items) {
    const method = uniqueName(toCamelIdentifier(s.title) || "action", usedMethods);
    lines.push("");
    lines.push(`  ${safeComment(`Scenario: ${s.title}`)}`);
    lines.push(`  async ${method}(): Promise<void> {`);
    lines.push(`    ${safeComment("TODO: implement page interactions for this scenario")}`);
    lines.push(`    await this.page.waitForLoadState();`);
    lines.push(`  }`);
  }
  lines.push(`}`);
  lines.push("");
  return lines.join("\n");
}

function renderSpec(
  className: string,
  feature: string,
  items: ReadonlyArray<ExportableSuggestion>,
): string {
  const lines: string[] = [];
  lines.push(`import { test } from "@playwright/test";`);
  lines.push(`import { ${className} } from "../pages/${className}.js";`);
  lines.push("");
  lines.push(`${safeComment(`Spec scaffold for feature: ${feature}`)}`);
  lines.push(`test.describe(${tsStringLiteral(`feature: ${feature}`)}, () => {`);

  const usedMethods = new Set<string>(["goto", "constructor"]);
  for (const s of items) {
    const method = uniqueName(toCamelIdentifier(s.title) || "action", usedMethods);
    lines.push(`  test.skip(${tsStringLiteral(s.title)}, async ({ page }) => {`);
    lines.push(`    const pom = new ${className}(page);`);
    lines.push(`    await pom.goto();`);
    for (const line of gwtComments(s)) {
      lines.push(`    ${line}`);
    }
    lines.push(`    await pom.${method}();`);
    lines.push(`  });`);
    lines.push("");
  }
  lines.push(`});`);
  lines.push("");
  return lines.join("\n");
}

function gwtComments(s: ExportableSuggestion): string[] {
  const out: string[] = [];
  const add = (kw: string, bucket: string | ReadonlyArray<string> | undefined) => {
    for (const line of collectLines(bucket)) out.push(safeComment(`${kw} ${line}`));
  };
  add("Given", s.gwt?.given);
  add("When", s.gwt?.when);
  add("Then", s.gwt?.then);
  for (const step of s.steps ?? []) {
    if (step?.action) out.push(safeComment(`Step: ${step.action}`));
  }
  return out;
}

function renderConfig(): string {
  return [
    `import { defineConfig } from "@playwright/test";`,
    "",
    `// Generated Playwright config snippet (Epic #260, issue #44).`,
    `export default defineConfig({`,
    `  testDir: "./tests",`,
    `  fullyParallel: true,`,
    `  reporter: "list",`,
    `  use: {`,
    `    baseURL: process.env.BASE_URL ?? "http://localhost:3000",`,
    `    trace: "on-first-retry",`,
    `  },`,
    `});`,
    "",
  ].join("\n");
}

// ---- safe encoders --------------------------------------------------------

function collectLines(text: string | ReadonlyArray<string> | undefined): string[] {
  if (!text) return [];
  const list = Array.isArray(text) ? text : [text as string];
  return list
    .flatMap((line) => line.split(/\r?\n/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Encode an arbitrary string as a safe double-quoted TypeScript string literal.
 * `JSON.stringify` escapes `"`, `\\`, and control chars; we additionally
 * neutralise `${` and backticks so the value is inert even if copied into a
 * template literal, and strip line separators that JSON leaves intact.
 */
export function tsStringLiteral(value: string): string {
  const cleaned = String(value)
    .replace(/\$\{/g, "$ {") // defang template-literal interpolation
    .replace(/`/g, "'") // defang backtick
    .replace(/[\u2028\u2029]/g, " ");
  return JSON.stringify(cleaned);
}

/** Render `value` as a single-line `// comment`, stripping anything that could
 * terminate the comment or smuggle code onto a new line. */
export function safeComment(value: string): string {
  const cleaned = String(value)
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\*\//g, "* /")
    .replace(/\$\{/g, "$ {")
    .replace(/`/g, "'")
    .trim();
  return `// ${cleaned}`;
}

/** PascalCase identifier built from alphanumerics only; never starts with a
 * digit; falls back to a stable default. */
export function toPascalIdentifier(value: string): string {
  const words = String(value)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  let id = words.join("");
  if (!id || /^[0-9]/.test(id)) id = `Feature${id}`;
  return id.replace(/[^A-Za-z0-9]/g, "");
}

/** camelCase identifier; alphanumerics only; never starts with a digit. */
export function toCamelIdentifier(value: string): string {
  const pascal = toPascalIdentifier(value);
  if (!pascal) return "";
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** Filesystem-safe slug: lowercase, alphanumerics + single dashes, no path
 * separators and no `..` traversal. */
export function toSafeSlug(value: string): string {
  const base = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "suite";
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let i = 2;
  while (used.has(name)) {
    name = `${base}${i}`;
    i += 1;
  }
  used.add(name);
  return name;
}
