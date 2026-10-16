/**
 * Issue #1162 — guard: no code writes a version-tracked requirement field
 * except through the version-history service.
 *
 * Version history is rebuilt by reversing the recorded changes from the
 * current row, so ONE writer that changes `body` (or any tracked field) with a
 * plain `prisma.requirement.update` silently corrupts every reconstructed
 * snapshot before it: a review pinned at version N shows text the reviewer was
 * never asked to approve. Clarification enrichment and import re-sync both did
 * exactly that. This test parses every server source file and fails on any
 * `*.requirement.update/updateMany/upsert` whose written data names a field in
 * `TRACKED_FIELDS` — or whose data it cannot read (a spread or a variable),
 * since that could carry one.
 *
 * The fix for a failure is `updateRequirementWithHistory`, not an allowlist
 * entry here.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { TRACKED_FIELDS } from "./requirement-version-service.js";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The one module allowed to write tracked fields: it records them. */
const VERSION_SERVICE = "lib/requirements/requirement-version-service.ts";

const WRITE_METHODS = new Set(["update", "updateMany", "upsert"]);

interface Violation {
  file: string;
  line: number;
  detail: string;
}

/** The written-data argument of a requirement write call, by method. */
function writtenData(method: string, arg: ts.ObjectLiteralExpression): ts.Expression | undefined {
  const key = method === "upsert" ? "update" : "data";
  for (const prop of arg.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name.getText() === key) return prop.initializer;
  }
  return undefined;
}

/** Find writes of tracked requirement fields in one source file. */
export function findTrackedRequirementWrites(source: string, file: string): Violation[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const tracked = new Set<string>(TRACKED_FIELDS);
  const out: Violation[] = [];
  const report = (node: ts.Node, detail: string) =>
    out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, detail });

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      WRITE_METHODS.has(node.expression.name.text) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === "requirement"
    ) {
      const method = node.expression.name.text;
      const [arg] = node.arguments;
      const data = arg && ts.isObjectLiteralExpression(arg) ? writtenData(method, arg) : undefined;
      if (!data || !ts.isObjectLiteralExpression(data)) {
        report(node, `requirement.${method} with data this guard cannot read`);
      } else {
        for (const prop of data.properties) {
          if (ts.isSpreadAssignment(prop)) {
            report(prop, `requirement.${method} spreads unknown fields into its data`);
          } else if (prop.name && tracked.has(prop.name.getText())) {
            report(prop, `requirement.${method} writes tracked field "${prop.name.getText()}"`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
      files.push(path);
  }
  return files;
}

describe("#1162 — tracked requirement fields are written only through version history", () => {
  it("no server source writes a tracked field with a direct requirement update", () => {
    const files = sourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(100);
    const violations = files
      .filter((f) => relative(SRC_ROOT, f) !== VERSION_SERVICE)
      .flatMap((f) => findTrackedRequirementWrites(readFileSync(f, "utf8"), relative(SRC_ROOT, f)));
    expect(violations).toEqual([]);
  });

  describe("the guard itself", () => {
    const check = (code: string) => findTrackedRequirementWrites(code, "x.ts");

    it("flags the enrichment's old direct body write", () => {
      expect(
        check(`await prisma.requirement.update({ where: { id }, data: { body: nextBody } });`),
      ).toEqual([{ file: "x.ts", line: 1, detail: expect.stringContaining('"body"') }]);
    });

    it("flags a write inside a transaction client and an upsert's update branch", () => {
      expect(check(`tx.requirement.updateMany({ where: {}, data: { title: "t" } })`)).toHaveLength(
        1,
      );
      expect(
        check(
          `db.requirement.upsert({ where: {}, create: { body: "" }, update: { labels: "[]" } })`,
        ),
      ).toHaveLength(1);
    });

    it("flags data it cannot read, which could carry a tracked field", () => {
      expect(check(`prisma.requirement.update({ where: {}, data: patch })`)).toHaveLength(1);
      expect(check(`prisma.requirement.update({ where: {}, data: { ...patch } })`)).toHaveLength(1);
      expect(check(`prisma.requirement.update(args)`)).toHaveLength(1);
    });

    it("allows untracked columns, creates, and other models", () => {
      expect(
        check(`
          prisma.requirement.update({ where: { id }, data: { parentId } });
          tx.requirement.updateMany({ where: {}, data: { reviewStatus: "draft" } });
          prisma.requirement.create({ data: { body: "b", title: "t" } });
          prisma.issueDraft.update({ where: {}, data: { body: "b" } });
        `),
      ).toEqual([]);
    });
  });
});
