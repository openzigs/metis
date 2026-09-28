/**
 * #309 — what every config key's schema ACCEPTS and what it PARSES TO, pinned
 * across the zod 3 → 4 upgrade. Recorded on zod 3 before the bump.
 *
 * `ConfigService.set` runs these schemas on every admin write, and the
 * registry leans on exactly the zod features whose semantics zod 4 changed:
 * `z.coerce.*` (input type now `unknown`), `.default()` (no longer re-parsed),
 * `.transform().pipe()`, unions, `z.number()` (no longer admits Infinity) and
 * `.int()` (now safe-integer only). One probe table over every key catches a
 * silent change in any of them. Only acceptance and the parsed value are
 * pinned — never zod's issue text, which is not part of the contract.
 */
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "../../../src/lib/config/key-registry.js";

const PROBES: ReadonlyArray<readonly [string, unknown]> = [
  ["undefined", undefined],
  ["null", null],
  ["empty", ""],
  ["space", " "],
  ["'0'", "0"],
  ["'1'", "1"],
  ["'-1'", "-1"],
  ["'30'", "30"],
  ["'1.5'", "1.5"],
  ["'1e3'", "1e3"],
  ["'5000'", "5000"],
  ["'99999999999999999'", "99999999999999999"],
  ["'Infinity'", "Infinity"],
  ["'abc'", "abc"],
  ["'true'", "true"],
  ["'false'", "false"],
  ["url", "https://example.com/path"],
  ["hosts", "a.example.com, b.example.com"],
  ["json-object", '{"a":1}'],
  ["json-array", '["x"]'],
  ["number 7", 7],
  ["boolean true", true],
  ["array", ["x"]],
  ["object", { a: 1 }],
];

function outcome(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } },
  v: unknown,
) {
  const r = schema.safeParse(v);
  if (!r.success) return "REJECT";
  return r.data === undefined ? "OK:undefined" : `OK:${JSON.stringify(r.data)}`;
}

describe("config key-registry parse semantics", () => {
  it("every key accepts and parses the probe table exactly as recorded", async () => {
    const table: Record<string, Record<string, string>> = {};
    for (const [key, def] of Object.entries(CONFIG_KEYS)) {
      table[key] = Object.fromEntries(PROBES.map(([label, v]) => [label, outcome(def.schema, v)]));
    }
    await expect(JSON.stringify(table, null, 2) + "\n").toMatchFileSnapshot(
      "./__snapshots__/key-registry-parse-semantics.json.snap",
    );
  });
});
