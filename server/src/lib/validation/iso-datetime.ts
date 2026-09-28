/**
 * An ISO 8601 datetime string schema that accepts exactly what zod 3.25.76's
 * `z.string().datetime()` accepted (#330).
 *
 * zod 4's `z.string().datetime()` is stricter: it rejects a time without
 * seconds (`2026-01-01T10:00Z`) and, with `{ offset: true }`, an offset without
 * a colon (`+0100`). Clients that sent those got a 2xx before the zod 4 upgrade
 * (#309), so every client-facing datetime field uses this instead.
 *
 * The pattern is zod 3's own `datetimeRegex` with its defaults (no `precision`,
 * no `local`): date with leap-year validation, `T`, `HH:MM` with optional
 * `:SS` and optional fractional seconds, then `Z` — or, with `offset`, also
 * `±HH:MM` / `±HHMM`. The issue raised on a mismatch keeps zod 4's datetime
 * message, so `{ issues: flatten() }` bodies read as they do on plain zod 4.
 */
import { z } from "zod";

const DATE =
  "((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|" +
  "\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))";
const TIME = "([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?";

const UTC = new RegExp(`^${DATE}T${TIME}(Z)$`);
const WITH_OFFSET = new RegExp(`^${DATE}T${TIME}(Z|([+-]\\d{2}:?\\d{2}))$`);

export function isoDatetime(opts: { offset?: boolean } = {}): z.ZodString {
  return z.string().regex(opts.offset ? WITH_OFFSET : UTC, { message: "Invalid ISO datetime" });
}
