/**
 * Issue #281 / Epic #34 — User search endpoint for @mention autocomplete.
 *
 * Routes:
 *   GET /api/users?search=<q>&limit=<n>  — search ACTIVE users by username or
 *                                          displayName for the mention picker.
 *
 * Requires authentication. Only NON-sensitive fields (id, username,
 * displayName) are ever returned — password hashes, emails, roles and SSO
 * metadata are deliberately excluded. Queries are fully parameterised via
 * Prisma (no raw user input), so the `search` term cannot be used for
 * injection.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 8;

const searchQuerySchema = z.object({
  search: z.string().trim().max(100).optional().default(""),
  // Page size: default 8 (matches the MentionInput dropdown). An out-of-range
  // or non-numeric value is clamped into [1, 25] rather than rejected, so a
  // generous client `limit` never 400s the autocomplete.
  limit: z.coerce
    .number()
    .optional()
    .transform((n) => {
      if (n === undefined || Number.isNaN(n)) return DEFAULT_LIMIT;
      const floored = Math.floor(n);
      return Math.min(Math.max(floored, 1), MAX_LIMIT);
    }),
});

export function usersRouter(): Router {
  const r = Router();

  /** GET /api/users — search active users for the @mention picker. */
  r.get("/", requireAuth, async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");

    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid user search query", {
        issues: parsed.error.flatten(),
      });
    }

    const { search, limit } = parsed.data;

    // SQLite `LIKE` is case-insensitive for ASCII, so a plain `contains` filter
    // gives prefix/substring matching without the Postgres-only
    // `mode: "insensitive"` option. The term is passed as a bound parameter by
    // Prisma — it is never interpolated into raw SQL.
    const where = {
      status: "active",
      ...(search
        ? {
            OR: [{ username: { contains: search } }, { displayName: { contains: search } }],
          }
        : {}),
    };

    const users = await prisma.user.findMany({
      where,
      // Never expose passwordHash, email, role, or SSO fields.
      select: { id: true, username: true, displayName: true },
      orderBy: { username: "asc" },
      take: limit,
    });

    res.json({ success: true, data: users });
  });

  return r;
}
