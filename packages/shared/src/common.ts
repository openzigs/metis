/**
 * Common zod helpers reused across domain schemas.
 */
import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./constants.js";

/** A cuid-shaped id (Prisma `cuid()` defaults). */
export const idSchema = z.string().min(10, "id is too short").max(64, "id is too long");

/** ISO-8601 datetime represented as a JS Date (z.coerce.date). */
export const dateSchema = z.coerce.date();

/** Pagination query params shared by every list endpoint. */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Generic paginated response envelope. */
export const paginatedResponseSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    total: z.number().int().min(0),
  });

/** Soft-delete fields that appear on most timestamped models. */
export const timestampsSchema = z.object({
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

/** Soft-delete tombstone column. */
export const softDeleteSchema = z.object({
  deletedAt: dateSchema.nullable(),
});
