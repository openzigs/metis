/**
 * Prisma's unique-constraint violation (`P2002`), matched on its code alone so
 * it works for both the real `PrismaClientKnownRequestError` and test doubles.
 */
export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === "P2002";
}
