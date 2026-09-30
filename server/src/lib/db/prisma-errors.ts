/**
 * Prisma's unique-constraint violation (`P2002`), matched on its code alone so
 * it works for both the real `PrismaClientKnownRequestError` and test doubles.
 */
export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === "P2002";
}

/** The constraint a unique violation names: an index name, or its columns. */
export interface UniqueViolationTarget {
  index?: string;
  fields?: string[];
}

/**
 * #463 — which constraint a P2002 violated, or `null` when the error does not
 * say. Prisma 7's driver adapters report it under
 * `meta.driverAdapterError.cause.constraint` (`{ index }` from Postgres,
 * `{ fields }` from SQLite); the classic engine reported `meta.target` (a
 * name or a column list).
 */
export function uniqueViolationTarget(err: unknown): UniqueViolationTarget | null {
  const meta = (err as { meta?: Record<string, unknown> } | null)?.meta;
  if (!meta || typeof meta !== "object") return null;
  const cause = (meta.driverAdapterError as { cause?: { constraint?: unknown } } | undefined)
    ?.cause;
  const constraint = cause?.constraint as { index?: unknown; fields?: unknown } | undefined;
  if (constraint && typeof constraint === "object") {
    if (typeof constraint.index === "string") return { index: constraint.index };
    if (isStringArray(constraint.fields)) return { fields: constraint.fields };
  }
  if (typeof meta.target === "string") return { index: meta.target };
  if (isStringArray(meta.target)) return { fields: meta.target };
  return null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
