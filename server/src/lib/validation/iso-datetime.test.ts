/**
 * #330 — `isoDatetime()` accepts exactly what zod 3.25.76's
 * `z.string().datetime()` accepted, so the zod 4 upgrade (#309) does not turn
 * a request that used to succeed into a 400.
 *
 * Every row's expectation was measured against zod 3.25.76 and zod 4.6.5 side
 * by side (both are in this lockfile); `!!` marks a row where the two differ,
 * i.e. where plain zod 4 would have broken a client.
 */
import { describe, expect, it } from "vitest";
import { isoDatetime } from "./iso-datetime.js";

// [input, zod 3 default, zod 3 { offset: true }]
const TABLE: ReadonlyArray<readonly [string, boolean, boolean]> = [
  ["2026-01-01T10:00:00Z", true, true],
  ["2026-01-01T10:00Z", true, true], // !! zod 4 rejects: no seconds
  ["2026-01-01T10:00:00.123Z", true, true],
  ["2026-01-01T10:00:00.123456789Z", true, true],
  ["2026-01-01T10:00:00+01:00", false, true],
  ["2026-01-01T10:00:00+0100", false, true], // !! zod 4 rejects: offset without colon
  ["2026-01-01T10:00+01:00", false, true], // !! zod 4 rejects: no seconds
  ["2026-01-01T10:00:00-05:30", false, true],
  ["2026-01-01T10:00:00+01", false, false],
  ["2026-01-01T10:00:00", false, false],
  ["2026-01-01T10Z", false, false],
  ["2026-01-01 10:00:00Z", false, false],
  ["2026-01-01T24:00:00Z", false, false],
  ["2026-01-01T10:60:00Z", false, false],
  ["2026-13-01T10:00:00Z", false, false],
  ["2024-02-29T10:00:00Z", true, true],
  ["2026-02-29T10:00:00Z", false, false],
  ["2026-04-31T10:00:00Z", false, false],
  ["2026-01-01T10:00:00.Z", false, false],
  ["2026-01-01t10:00:00z", false, false],
  ["", false, false],
];

describe("isoDatetime — zod 3 datetime parity", () => {
  it.each(TABLE)("%s → default %s, offset %s", (input, utc, offset) => {
    expect(isoDatetime().safeParse(input).success).toBe(utc);
    expect(isoDatetime({ offset: true }).safeParse(input).success).toBe(offset);
  });

  it("rejects a non-string with a type issue", () => {
    const res = isoDatetime().safeParse(1_767_261_600_000);
    expect(res.success).toBe(false);
    expect(res.error?.issues[0].code).toBe("invalid_type");
  });

  it("keeps zod 4's datetime message for a malformed string", () => {
    const res = isoDatetime().safeParse("tomorrow");
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]).toMatchObject({
      code: "invalid_format",
      message: "Invalid ISO datetime",
    });
  });
});
