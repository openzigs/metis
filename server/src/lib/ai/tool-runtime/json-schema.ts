/**
 * Epic #128 / #140 — describe a registry tool's zod argument schema as the JSON
 * Schema a provider's native tool definition carries.
 *
 * Hand-rolled on purpose. zod 4 ships `z.toJSONSchema`, but its output is NOT
 * what providers have been receiving: it adds `$schema`, `additionalProperties`,
 * length/range bounds and defaults. #309 took zod 3 → 4 with a must-preserve on
 * the wire schemas, so this keeps the exact zod 3-era shape and only reads zod
 * 4's internals (`_zod.def.type`, where zod 3 had `_def.typeName`). The
 * recorded bytes are pinned by `provider-wire-schemas.test.ts`.
 *
 * It covers the shapes the registry's tools actually use. Anything it does not
 * recognise becomes `{}` ("any value"): the description is only a HINT to the
 * model, the zod schema still validates every call server-side before it runs.
 */
import type { z } from "zod";

type Json = Record<string, unknown>;

/** The slice of zod 4's `_zod.def` this converter reads. */
interface ZodDefLike {
  type?: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  entries?: Record<string, string | number>;
  values?: unknown[];
  options?: z.ZodType[];
  in?: z.ZodType;
  out?: z.ZodType;
}

function defOf(schema: z.ZodType): ZodDefLike {
  return (schema as unknown as { _zod?: { def?: ZodDefLike } })._zod?.def ?? {};
}

function withDescription(out: Json, schema: z.ZodType): Json {
  const description = schema.description;
  return description ? { ...out, description } : out;
}

/** True when a property may be omitted (optional, or defaulted). */
function isOptional(schema: z.ZodType): boolean {
  const t = defOf(schema).type;
  return t === "optional" || t === "default";
}

export function zodToJsonSchema(schema: z.ZodType, depth = 0): Json {
  if (depth > 12) return {};
  const def = defOf(schema);
  switch (def.type) {
    case "object": {
      const shape = (schema as unknown as { shape: Record<string, z.ZodType> }).shape ?? {};
      const properties: Json = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value, depth + 1);
        if (!isOptional(value)) required.push(key);
      }
      return withDescription(
        { type: "object", properties, ...(required.length > 0 ? { required } : {}) },
        schema,
      );
    }
    case "string":
      return withDescription({ type: "string" }, schema);
    case "number": {
      const isInt = (schema as unknown as { isInt?: boolean }).isInt === true;
      return withDescription({ type: isInt ? "integer" : "number" }, schema);
    }
    case "boolean":
      return withDescription({ type: "boolean" }, schema);
    case "array":
      return withDescription(
        { type: "array", items: def.element ? zodToJsonSchema(def.element, depth + 1) : {} },
        schema,
      );
    case "enum":
      return withDescription(
        { type: "string", enum: def.entries ? Object.values(def.entries) : [] },
        schema,
      );
    case "literal":
      return withDescription({ const: def.values?.[0] }, schema);
    case "record":
      return withDescription({ type: "object" }, schema);
    case "union":
      return withDescription(
        { anyOf: (def.options ?? []).map((o) => zodToJsonSchema(o, depth + 1)) },
        schema,
      );
    case "optional":
    case "nullable":
    case "default":
      return def.innerType
        ? withDescription(zodToJsonSchema(def.innerType, depth + 1), schema)
        : {};
    case "pipe": {
      // zod 3's ZodEffects: `.transform()` is pipe(schema → transform) and
      // `z.preprocess()` is pipe(transform → schema); describe the SCHEMA side.
      // A plain `.pipe(a, b)` was zod 3's ZodPipeline, which this never described.
      const inner =
        def.out && defOf(def.out).type === "transform"
          ? def.in
          : def.in && defOf(def.in).type === "transform"
            ? def.out
            : undefined;
      return inner ? withDescription(zodToJsonSchema(inner, depth + 1), schema) : {};
    }
    default:
      return withDescription({}, schema);
  }
}

/** A tool's top-level parameters must be an object schema on both wire formats. */
export function toolParametersSchema(schema: z.ZodType): Json {
  const out = zodToJsonSchema(schema);
  return out.type === "object" ? out : { type: "object", properties: {} };
}
