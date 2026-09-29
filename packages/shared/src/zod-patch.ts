/**
 * #346 — PATCH schemas that leave an omitted field alone.
 *
 * Under zod 4, `.partial()` wraps each field in `ZodOptional`, but an absent key
 * still reaches the inner schema, so an inner `.default()` fires: parsing `{}`
 * with `z.object({ enabled: z.boolean().default(true) }).partial()` yields
 * `{ enabled: true }`, not `{}`. (Zod 3 short-circuited the absent key.) A PATCH
 * schema built as `createSchema.partial()` therefore writes the create defaults
 * for every field the caller left out — renaming a disabled trigger re-enabled
 * it. Build PATCH schemas with {@link patchSchemaOf} instead.
 */
import { z } from "zod";

/** A field schema with its absent-key default (at any optional/nullable depth) removed. */
export type WithoutDefault<T> =
  T extends z.ZodDefault<infer I extends z.ZodType>
    ? WithoutDefault<I>
    : T extends z.ZodPrefault<infer I extends z.ZodType>
      ? WithoutDefault<I>
      : T extends z.ZodOptional<infer I extends z.ZodType>
        ? z.ZodOptional<WithoutDefault<I>>
        : T extends z.ZodNullable<infer I extends z.ZodType>
          ? z.ZodNullable<WithoutDefault<I>>
          : T;

type ShapeWithoutDefaults<S extends z.ZodRawShape> = { [K in keyof S]: WithoutDefault<S[K]> };

function stripDefault(field: z.ZodType): z.ZodType {
  if (field instanceof z.ZodDefault || field instanceof z.ZodPrefault) {
    return stripDefault(field.unwrap() as z.ZodType);
  }
  if (field instanceof z.ZodOptional) return stripDefault(field.unwrap() as z.ZodType).optional();
  if (field instanceof z.ZodNullable) return stripDefault(field.unwrap() as z.ZodType).nullable();
  return field;
}

/**
 * The same object schema with every field's `.default()` / `.prefault()`
 * removed. Validation rules, `null` handling and the object's unknown-key
 * policy are unchanged; only "fill this in when absent" goes.
 */
export function withoutDefaults<S extends z.ZodRawShape, C extends z.core.$ZodObjectConfig>(
  schema: z.ZodObject<S, C>,
): z.ZodObject<ShapeWithoutDefaults<S>, C> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    shape[key] = stripDefault(field as z.ZodType);
  }
  return schema.extend(shape) as unknown as z.ZodObject<ShapeWithoutDefaults<S>, C>;
}

/**
 * The PATCH counterpart of a create schema: every field optional, and an
 * omitted field stays omitted (`patchSchemaOf(s).parse({})` is `{}`), so the
 * service leaves the stored column untouched.
 */
export function patchSchemaOf<S extends z.ZodRawShape, C extends z.core.$ZodObjectConfig>(
  schema: z.ZodObject<S, C>,
) {
  // The one sanctioned `.partial()` (#346 lint rule): the defaults are gone.
  // eslint-disable-next-line no-restricted-syntax
  return withoutDefaults(schema).partial();
}

/**
 * The keys of an object schema that take a value when ABSENT from the input —
 * for a PATCH schema, each one is a stored field silently overwritten on every
 * update that does not name it. Empty for a well-formed PATCH schema. Used by
 * the guard tests; cheap enough to call anywhere.
 */
export function keysFilledWhenAbsent(schema: z.ZodObject): string[] {
  const filled: string[] = [];
  for (const [key, field] of Object.entries(schema.shape)) {
    const parsed = (field as z.ZodType).safeParse(undefined);
    if (parsed.success && parsed.data !== undefined) filled.push(key);
  }
  return filled;
}
