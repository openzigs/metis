/**
 * #268 — source guards for the accessible-primitive migration.
 *
 * The component tests prove the ui-kit Tabs / Dialog / AlertDialog behave.
 * These guards prove the app actually USES them, and stay green only while no
 * one reintroduces the hand-rolled versions:
 *
 *  1. no hand-rolled `role="tablist"` — use `Tabs` from `@/components/ui/tabs`;
 *  2. no `window.confirm` / bare `confirm()` — use `AlertDialog`;
 *  3. no hand-made `fixed inset-0 … bg-black/NN` modal backdrop — use `Dialog`;
 *  4. every icon-only button (children are only icons or glyphs such as `✕`)
 *     carries an accessible name (`aria-label`, `aria-labelledby`, `title`, or
 *     an `sr-only` child).
 *
 * The icon-button check parses the TSX with the TypeScript compiler rather than
 * a regex, so a multi-line `<Button …>` with the glyph on its own line is seen.
 * It is deliberately conservative: a child that is a `{expression}` may render
 * text, so such a button is NOT reported.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const UI_ROOT = [process.cwd(), path.join(process.cwd(), "ui")].find((dir) => {
  try {
    return statSync(path.join(dir, "src", "app")).isDirectory();
  } catch {
    return false;
  }
});
if (!UI_ROOT) throw new Error(`ui/src not found from ${process.cwd()}`);
const SRC = path.join(UI_ROOT, "src");
const UI_KIT_SRC = path.resolve(UI_ROOT, "..", "packages", "ui-kit", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const APP_FILES = walk(SRC);
const ALL_FILES = [...APP_FILES, ...walk(UI_KIT_SRC)];
const rel = (f: string) => path.relative(path.resolve(UI_ROOT, ".."), f);

/** Strip comments so prose that mentions `confirm()` does not count. */
function code(file: string): string {
  const src = readFileSync(file, "utf8");
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function offenders(files: string[], re: RegExp): string[] {
  return files.filter((f) => re.test(code(f))).map(rel);
}

describe("accessible primitives are used, not hand-rolled (#268)", () => {
  it("no hand-rolled tablists outside the ui-kit Tabs", () => {
    expect(offenders(APP_FILES, /role=["']tablist["']/)).toEqual([]);
  });

  it("no window.confirm / confirm() calls — AlertDialog instead", () => {
    expect(offenders(APP_FILES, /(?<![\w.])(?:window\.|globalThis\.)?confirm\s*\(/)).toEqual([]);
  });

  it("no hand-made modal backdrops — Dialog instead", () => {
    expect(offenders(APP_FILES, /fixed inset-0[^"'`]*bg-black\//)).toEqual([]);
  });
});

// ── icon-only buttons ─────────────────────────────────────────────────────────

const NAME_ATTRS = new Set(["aria-label", "aria-labelledby", "title"]);
/** Text a screen reader cannot turn into a meaningful name on its own. */
const GLYPH_ONLY = /^[\s✕✖×xX✓✔+\-−–…⋯·•←→↑↓⟵⟶▲▼▶◀‹›«»⌄⌃☰⋮⧉⤢⤡⎘🗑]*$/u;

function tagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

function hasNameAttr(attrs: ts.JsxAttributes): boolean {
  return attrs.properties.some((p) => {
    if (ts.isJsxSpreadAttribute(p)) return true; // could carry a name — do not guess
    return NAME_ATTRS.has(p.name.getText());
  });
}

/** Identifiers the file imports from `lucide-react` — the app's icon set. */
function lucideImports(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === "lucide-react" &&
      stmt.importClause?.namedBindings &&
      ts.isNamedImports(stmt.importClause.namedBindings)
    ) {
      for (const el of stmt.importClause.namedBindings.elements) names.add(el.name.text);
    }
  }
  return names;
}

/**
 * Returns true when every child is an icon or a glyph-only text node. An icon
 * is a component imported from `lucide-react` (or named `*Icon`); any other
 * component may render text, so it is not guessed at.
 */
function iconOnlyChildren(children: ts.NodeArray<ts.JsxChild>, icons: Set<string>): boolean {
  const isIcon = (name: string) => icons.has(name) || /Icon$/.test(name);
  let sawContent = false;
  for (const child of children) {
    if (ts.isJsxText(child)) {
      if (child.getText().trim() === "") continue;
      if (!GLYPH_ONLY.test(child.getText())) return false;
      sawContent = true;
    } else if (ts.isJsxSelfClosingElement(child)) {
      // A lowercase tag (<span/>, <img/>) or a non-icon component may name the
      // button; only PascalCase components ending like lucide icons count.
      const name = tagName(child);
      if (!isIcon(name)) return false;
      if (
        child.attributes.properties.some(
          (p) => !ts.isJsxSpreadAttribute(p) && p.name.getText() === "alt",
        )
      ) {
        return false;
      }
      sawContent = true;
    } else if (ts.isJsxElement(child)) {
      const name = tagName(child.openingElement);
      const cls = child.openingElement.attributes.properties.find(
        (p) => !ts.isJsxSpreadAttribute(p) && p.name.getText() === "className",
      );
      if (cls && /sr-only/.test(cls.getText())) return false; // visually hidden label
      if (
        /^[A-Z]/.test(name) &&
        child.children.every((c) => ts.isJsxText(c) && !c.getText().trim())
      ) {
        sawContent = true; // <Icon></Icon>
        continue;
      }
      if (!iconOnlyChildren(child.children, icons)) return false;
      sawContent = true;
    } else {
      return false; // {expression} or fragment: may render text — do not guess
    }
  }
  return sawContent;
}

function findUnnamedIconButtons(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const icons = lucideImports(sf);
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      const open = node.openingElement;
      const name = tagName(open);
      const isButton =
        name === "button" || name === "Button" || /(?:Close|Action|Cancel)$/.test(name);
      const asChild = open.attributes.properties.some(
        (p) => !ts.isJsxSpreadAttribute(p) && p.name.getText() === "asChild",
      );
      if (
        isButton &&
        !asChild &&
        !hasNameAttr(open.attributes) &&
        iconOnlyChildren(node.children, icons)
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(open.getStart());
        found.push(`${fileName}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("icon-only buttons have an accessible name (#268, WCAG 4.1.2 / 2.4.6)", () => {
  it("the scanner flags an unlabelled ✕ and an unlabelled icon, and accepts named ones", () => {
    const src = `import { X, Trash2 } from "lucide-react";
      const a = <Button variant="ghost" onClick={f}>
        ✕
      </Button>;
      const b = <button type="button"><X className="h-4 w-4" /></button>;
      const c = <Button aria-label="Close" onClick={f}>✕</Button>;
      const d = <button><X /><span className="sr-only">Close</span></button>;
      const e = <Button>✕ Reject</Button>;
      const g = <Button>{label}</Button>;
      const h = <Button title="Remove"><Trash2 /></Button>;
      const i = <button><CellSummary item={item} /></button>;
    `;
    expect(findUnnamedIconButtons("fixture.tsx", src)).toEqual(["fixture.tsx:2", "fixture.tsx:5"]);
  });

  it("no unnamed icon-only buttons in ui/src or packages/ui-kit/src", () => {
    const hits = ALL_FILES.filter((f) => f.endsWith(".tsx")).flatMap((f) =>
      findUnnamedIconButtons(rel(f), readFileSync(f, "utf8")),
    );
    expect(hits).toEqual([]);
  });
});
