/**
 * Issue #1330 — a Prisma delegate fake that VALIDATES a create payload against
 * `schema.prisma`, instead of accepting whatever it is handed.
 *
 * ## Why this exists
 *
 * `materializeTriagedFinding` wrote five columns `Finding` does not have and
 * omitted two it requires, for eight months, under a test that asserted
 * `expect(tx.finding.create).toHaveBeenCalledTimes(1)` against
 * `finding: { create: vi.fn().mockResolvedValue({ id: "find-1" }) }`. Every
 * possible payload satisfies that assertion, so the mock could only ever
 * confirm the call happened — never that a real client would accept it. **A
 * mock you wrote cannot be the oracle for a schema you did not.**
 *
 * The oracle here is `server/prisma/schema.prisma` itself, read from disk and
 * parsed at test time. Rename a column in a payload and the fake rejects it the
 * way Prisma would, with no fixture to update in step. It costs no database and
 * runs identically under both generated clients, unlike a real-client test
 * (`src/lib/portability/logical-roundtrip.test.ts` is SQLite-only for exactly
 * that reason).
 *
 * ## Fail-closed properties
 *
 * This repo has shipped a long line of gates that could not fail, so:
 *
 *   1. {@link parsePrismaModel} THROWS when the model block is absent or yields
 *      no fields. A parser that silently returns `[]` would make the fake
 *      accept everything — the exact failure it replaces.
 *   2. {@link makeValidatingCreateFake} throws on an unknown key AND on a
 *      missing required key. Checking only one of the two would have let
 *      #1330's payload through (it did both at once).
 *   3. The parser and the fake are unit-tested against their own red paths in
 *      `prisma-model-schema.test.ts`, including a deliberately blinded parser.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Prisma scalar types. Anything else in type position is a relation or enum. */
const SCALAR_TYPES = new Set([
  "String",
  "Boolean",
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "DateTime",
  "Json",
  "Bytes",
]);

export interface PrismaField {
  name: string;
  /** Declared type with `?` and `[]` stripped. */
  type: string;
  /** `Type?` — nullable, therefore never required on create. */
  optional: boolean;
  /** `Type[]` — a list, therefore never required on create. */
  list: boolean;
  /** Carries `@default(...)`, therefore never required on create. */
  hasDefault: boolean;
  /** Type is not a Prisma scalar — a relation field (or enum; this repo has none). */
  relation: boolean;
}

/** `server/prisma/schema.prisma`, the SQLite source of truth. */
export function readSchemaText(): string {
  return readFileSync(fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url)), {
    encoding: "utf8",
  });
}

/**
 * The fields of one `model` block.
 *
 * Deliberately a small line parser, not a Prisma AST: the only shapes it must
 * read are `name Type[?|[]] @attrs` lines, and depending on Prisma's internals
 * would make this fake as version-fragile as the client it replaces.
 *
 * @throws when the model is not found, or is found but yields no fields — the
 * two ways this could quietly degrade into "accepts anything".
 */
export function parsePrismaModel(schemaText: string, modelName: string): PrismaField[] {
  const start = new RegExp(`^model\\s+${modelName}\\s*\\{`, "m").exec(schemaText);
  if (!start) throw new Error(`model ${modelName} not found in schema.prisma`);
  const bodyStart = start.index + start[0].length;
  const end = schemaText.indexOf("\n}", bodyStart);
  if (end === -1) throw new Error(`model ${modelName} block is unterminated`);

  const fields: PrismaField[] = [];
  for (const raw of schemaText.slice(bodyStart, end).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("///") || line.startsWith("@@")) continue;
    const m = /^(\w+)\s+(\w+)(\[\])?(\?)?(\s+.*)?$/.exec(line);
    if (!m) continue;
    const [, name, type, list, optional, attrs = ""] = m;
    fields.push({
      name,
      type,
      optional: Boolean(optional),
      list: Boolean(list),
      hasDefault: /@default\(/.test(attrs),
      relation: !SCALAR_TYPES.has(type),
    });
  }
  if (fields.length === 0) throw new Error(`model ${modelName} parsed to zero fields`);
  return fields;
}

/** Keys a `create({ data })` may carry: every scalar and every relation field. */
export function creatableKeys(fields: readonly PrismaField[]): Set<string> {
  return new Set(fields.map((f) => f.name));
}

/**
 * Keys a `create({ data })` MUST carry: non-optional, non-list, non-relation
 * scalars with no `@default`.
 *
 * A relation is excluded because the unchecked form supplies its scalar FK
 * instead, and both spellings are legal.
 */
export function requiredCreateKeys(fields: readonly PrismaField[]): string[] {
  return fields
    .filter((f) => !f.optional && !f.list && !f.hasDefault && !f.relation)
    .map((f) => f.name);
}

export interface ValidatingCreateFake {
  (args: { data: Record<string, unknown>; select?: unknown }): Promise<{ id: string }>;
  /** Every payload this fake accepted, in call order. */
  readonly calls: Record<string, unknown>[];
}

/**
 * A `delegate.create` stand-in that rejects what the real client would reject.
 *
 * Errors are worded like Prisma's own so a failure reads the same as the
 * production one #1330 produced (`Argument \`body\` is missing.`).
 */
export function makeValidatingCreateFake(
  fields: readonly PrismaField[],
  options: { modelName: string; returnId?: string } = { modelName: "Model" },
): ValidatingCreateFake {
  const allowed = creatableKeys(fields);
  const required = requiredCreateKeys(fields);
  const calls: Record<string, unknown>[] = [];

  const fake = async (args: {
    data: Record<string, unknown>;
    select?: unknown;
  }): Promise<{ id: string }> => {
    const data = args?.data;
    if (!data || typeof data !== "object") {
      throw new Error(`Invalid \`${options.modelName}.create()\` invocation: \`data\` is missing.`);
    }
    for (const key of Object.keys(data)) {
      if (!allowed.has(key)) {
        throw new Error(
          `Invalid \`${options.modelName}.create()\` invocation: Unknown argument \`${key}\`.`,
        );
      }
    }
    for (const key of required) {
      if (data[key] === undefined || data[key] === null) {
        throw new Error(
          `Invalid \`${options.modelName}.create()\` invocation: Argument \`${key}\` is missing.`,
        );
      }
    }
    calls.push(data);
    return { id: options.returnId ?? "generated-id" };
  };
  return Object.assign(fake, { calls }) as ValidatingCreateFake;
}
