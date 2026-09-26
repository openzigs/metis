/**
 * Epic #128 / #140 — describe a registry tool's zod argument schema as the JSON
 * Schema a provider's native tool definition carries.
 *
 * The server is on zod 3 (`server/package.json`), whose classic API has no
 * JSON-Schema export, and no converter is a dependency — so this covers the
 * shapes the registry's tools actually use. Anything it does not recognise
 * becomes `{}` ("any value"): the description is only a HINT to the model, the
 * zod schema still validates every call server-side before it runs.
 */
import type { z } from "zod";

type Json = Record<string, unknown>;

interface ZodDefLike {
  typeName?: string;
  description?: string;
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  values?: unknown;
  value?: unknown;
  options?: z.ZodTypeAny[];
  checks?: Array<{ kind?: string }>;
  valueType?: z.ZodTypeAny;
}

function defOf(schema: z.ZodTypeAny): ZodDefLike {
  return (schema as unknown as { _def?: ZodDefLike })._def ?? {};
}

function withDescription(out: Json, schema: z.ZodTypeAny): Json {
  const description = schema.description;
  return description ? { ...out, description } : out;
}

/** True when a property may be omitted (optional, or defaulted). */
function isOptional(schema: z.ZodTypeAny): boolean {
  const t = defOf(schema).typeName;
  return t === "ZodOptional" || t === "ZodDefault";
}

export function zodToJsonSchema(schema: z.ZodTypeAny, depth = 0): Json {
  if (depth > 12) return {};
  const def = defOf(schema);
  switch (def.typeName) {
    case "ZodObject": {
      const shape = (schema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape ?? {};
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
    case "ZodString":
      return withDescription({ type: "string" }, schema);
    case "ZodNumber": {
      const isInt = (def.checks ?? []).some((c) => c.kind === "int");
      return withDescription({ type: isInt ? "integer" : "number" }, schema);
    }
    case "ZodBoolean":
      return withDescription({ type: "boolean" }, schema);
    case "ZodArray":
      return withDescription(
        { type: "array", items: def.type ? zodToJsonSchema(def.type, depth + 1) : {} },
        schema,
      );
    case "ZodEnum":
      return withDescription(
        { type: "string", enum: Array.isArray(def.values) ? [...def.values] : [] },
        schema,
      );
    case "ZodLiteral":
      return withDescription({ const: def.value }, schema);
    case "ZodRecord":
      return withDescription({ type: "object" }, schema);
    case "ZodUnion":
      return withDescription(
        { anyOf: (def.options ?? []).map((o) => zodToJsonSchema(o, depth + 1)) },
        schema,
      );
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
      return def.innerType
        ? withDescription(zodToJsonSchema(def.innerType, depth + 1), schema)
        : {};
    case "ZodEffects":
      return def.schema ? withDescription(zodToJsonSchema(def.schema, depth + 1), schema) : {};
    default:
      return withDescription({}, schema);
  }
}

/** A tool's top-level parameters must be an object schema on both wire formats. */
export function toolParametersSchema(schema: z.ZodTypeAny): Json {
  const out = zodToJsonSchema(schema);
  return out.type === "object" ? out : { type: "object", properties: {} };
}
