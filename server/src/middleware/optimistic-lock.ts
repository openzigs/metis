/**
 * Epic #728 / Issue #733 — Optimistic-locking middleware.
 *
 * Reads `version` from the request body and compares it against the
 * DB record's current version field. If they differ, returns 409 with a
 * structured conflict payload so the UI can show a 3-way merge modal.
 *
 * On match, the middleware stores the incremented version in `res.locals`
 * so the route handler can persist it atomically.
 *
 * Usage:
 *   router.put('/:id', requireAuth, optimisticLock('requirement', getReq), handler)
 *
 * The `getRecord` callback receives (req) and must return `{ version: number }`
 * or `null` (record not found).
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { AppError } from "./error-handler.js";

export interface VersionedRecord {
  version: number;
  [key: string]: unknown;
}

type RecordFetcher = (req: Request) => Promise<VersionedRecord | null>;

/**
 * Structural equality for conflict-diff comparison.
 *
 * `JSON.stringify` was the first fix (identity comparison reported every
 * array/object field as conflicting), but it compares serialized key ORDER, so
 * `{a:1,b:2}` and `{b:2,a:1}` still read as different — and Prisma's JSON
 * column round-trip does not promise key order. It also equates a field
 * explicitly sent as `undefined` with one that is absent. Compare the shapes
 * instead: order-insensitive for objects, order-SENSITIVE for arrays (a
 * reordered label list is a real edit), and `undefined` distinguished from
 * `null`.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // NaN === NaN is false, but two NaNs are not a user-visible edit.
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const x = a as unknown[];
    const y = b as unknown[];
    return x.length === y.length && x.every((item, i) => valuesEqual(item, y[i]));
  }

  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const xKeys = Object.keys(x);
  const yKeys = Object.keys(y);
  if (xKeys.length !== yKeys.length) return false;
  // `in` rather than `y[k] !== undefined`: a key present with value
  // `undefined` is not the same as a missing key.
  return xKeys.every((k) => k in y && valuesEqual(x[k], y[k]));
}

/**
 * Build the optimistic-lock middleware for a given record fetcher.
 *
 * @param entityLabel  Used in error messages, e.g. "requirement".
 * @param getRecord    Async fn that fetches the current DB record.
 */
export function optimisticLock(entityLabel: string, getRecord: RecordFetcher): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const clientVersion = (req.body as Record<string, unknown> | undefined)?.version;
      // If the client didn't send a version, skip locking (backwards compat).
      if (clientVersion === undefined || clientVersion === null) {
        return next();
      }
      if (typeof clientVersion !== "number") {
        throw new AppError(400, "VALIDATION_ERROR", "`version` must be a number");
      }

      const record = await getRecord(req);
      if (!record) {
        throw new AppError(
          404,
          `${entityLabel.toUpperCase()}_NOT_FOUND`,
          `${entityLabel} not found`,
        );
      }

      if (record.version !== clientVersion) {
        // 409 — version conflict; surface a field-level diff for the 3-way
        // merge UI. We intentionally do NOT include the full server record or
        // full request body to avoid leaking unrelated field values.
        const clientBody = req.body as Record<string, unknown>;
        const diff: Array<{ field: string; server: unknown; client: unknown }> = [];
        for (const field of Object.keys(clientBody)) {
          if (field === "version") continue;
          if (!(field in record)) continue;
          // Structural comparison: a field whose value is an array or object
          // (e.g. a requirement's `labels`) is never `===` equal to an
          // equivalent value from the request body, so identity comparison
          // reported it as conflicting on EVERY conflict — and the merge modal
          // then offered a "server version" the client never actually differed
          // from. See `valuesEqual` for why this is not `JSON.stringify`.
          if (!valuesEqual(record[field], clientBody[field])) {
            diff.push({ field, server: record[field], client: clientBody[field] });
          }
        }
        res.status(409).json({
          success: false,
          error: {
            code: "VERSION_CONFLICT",
            message: `${entityLabel} has been modified since you loaded it`,
            conflict: true,
            serverVersion: record.version,
            clientVersion: clientVersion as number,
            diff,
          },
        });
        return;
      }

      // Version matches — store incremented version for the route handler.
      res.locals.nextVersion = record.version + 1;
      next();
    } catch (err) {
      next(err);
    }
  };
}
