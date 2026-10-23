/**
 * #1447 — every notification the server can write records its project.
 *
 * Reads re-check the reader's access to `Notification.projectId` and redact a
 * row without one for EVERY reader (`lib/notifications/visibility.ts`). So a
 * writer that forgets `projectId` ships a notification nobody can read, and a
 * genuinely project-less type has to opt in deliberately through
 * `PROJECTLESS_NOTIFICATION_TYPES`.
 *
 * This enumerates every `<client>.notification.create|createMany|upsert` call
 * in `server/src` from the source (TypeScript AST, not a regex), and every
 * notification `type` those calls can write, then asserts:
 *   - each call's `data` sets `projectId`, or writes only opted-in types;
 *   - the set of types is exactly the known one, so a new type fails here
 *     until someone decides where its project comes from;
 *   - both backfill migrations handle every type;
 *   - nothing inserts notifications through raw SQL.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { PROJECTLESS_NOTIFICATION_TYPES } from "../src/lib/notifications/visibility.js";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(SERVER, "src");
const MIGRATION = "20261028001447_issue1447_notification_project_id";

/** Every type the server writes today, and the backfill branch for each. */
const KNOWN_TYPES = [
  "discussion_mention",
  "mention",
  "review_approved",
  "review_decided",
  "review_rejected",
  "review_requested",
  "sla_deadline",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name) && !name.endsWith(".d.ts")
      ? [full]
      : [];
  });
}

/** The string-literal members of a `type X = "a" | "b"` alias in `file`. */
function unionLiterals(file: string, alias: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  for (const stmt of sf.statements) {
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === alias) {
      const t = stmt.type;
      const members = ts.isUnionTypeNode(t) ? t.types : [t];
      return members.flatMap((m) =>
        ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal) ? [m.literal.text] : [],
      );
    }
  }
  throw new Error(`type ${alias} not found in ${file}`);
}

/**
 * Writers whose `type` is not a string literal, and where its values are
 * declared. A new non-literal writer fails until it is listed here.
 */
const NON_LITERAL_TYPES: Record<string, () => string[]> = {
  "lib/reviews/notify.ts:n.kind": () =>
    unionLiterals(path.join(SRC, "lib/reviews/notify.ts"), "ReviewNotificationKind"),
};

interface Writer {
  where: string;
  method: string;
  types: string[];
  setsProjectId: boolean;
}

function prop(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      ts.isIdentifier(p.name) &&
      p.name.text === name,
  );
}

function findWriters(): Writer[] {
  const writers: Writer[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("notification.")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["create", "createMany", "upsert"].includes(node.expression.name.text) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === "notification"
      ) {
        const method = node.expression.name.text;
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const where = `${rel}:${line}`;
        const arg = node.arguments[0];
        const dataKey = method === "upsert" ? "create" : "data";
        const dataProp = arg && ts.isObjectLiteralExpression(arg) ? prop(arg, dataKey) : undefined;
        const data =
          dataProp && ts.isPropertyAssignment(dataProp) ? dataProp.initializer : undefined;
        if (!data || !ts.isObjectLiteralExpression(data)) {
          throw new Error(`${where}: notification.${method} data is not an object literal`);
        }
        const typeProp = prop(data, "type");
        let types: string[];
        if (
          typeProp &&
          ts.isPropertyAssignment(typeProp) &&
          ts.isStringLiteralLike(typeProp.initializer)
        ) {
          types = [typeProp.initializer.text];
        } else {
          const expr =
            typeProp && ts.isPropertyAssignment(typeProp)
              ? typeProp.initializer.getText(sf)
              : "<none>";
          const resolve = NON_LITERAL_TYPES[`${rel}:${expr}`];
          if (!resolve) throw new Error(`${where}: unlisted non-literal type \`${expr}\``);
          types = resolve();
        }
        writers.push({
          where,
          method,
          types,
          setsProjectId: prop(data, "projectId") !== undefined,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return writers;
}

describe("#1447 — every notification writer records its project", () => {
  const writers = findWriters();

  it("finds the writers (the scan is not vacuous)", () => {
    // mentions, discussions, reviews, and the SLA checker's two recipients.
    expect(writers.length).toBeGreaterThanOrEqual(5);
    expect(new Set(writers.map((w) => w.where.split(":")[0]))).toEqual(
      new Set([
        "lib/collaboration/mentions.ts",
        "lib/collaboration/sla-checker.ts",
        "lib/discussions/notify.ts",
        "lib/reviews/notify.ts",
      ]),
    );
  });

  it("each writer sets projectId, or writes only types opted in as project-less", () => {
    const offenders = writers
      .filter(
        (w) => !w.setsProjectId && !w.types.every((t) => PROJECTLESS_NOTIFICATION_TYPES.has(t)),
      )
      .map((w) => `${w.where} (${w.types.join(", ")})`);
    expect(offenders).toEqual([]);
  });

  it("the writable types are exactly the known ones — a new type must be placed", () => {
    const types = [...new Set(writers.flatMap((w) => w.types))].sort();
    expect(types).toEqual(KNOWN_TYPES);
  });

  it("no type is opted out of the project check today", () => {
    expect([...PROJECTLESS_NOTIFICATION_TYPES]).toEqual([]);
  });

  it("both backfill migrations handle every known type", () => {
    for (const dir of ["prisma/migrations", "prisma/postgres/migrations"]) {
      const sql = readFileSync(path.join(SERVER, dir, MIGRATION, "migration.sql"), "utf8");
      for (const t of KNOWN_TYPES) expect(sql, `${dir}: ${t}`).toContain(`'${t}'`);
    }
  });

  it("nothing inserts notifications through raw SQL", () => {
    const raw = sourceFiles(SRC).filter((f) =>
      /INSERT\s+INTO\s+"?notifications"?/i.test(readFileSync(f, "utf8")),
    );
    expect(raw).toEqual([]);
  });
});
