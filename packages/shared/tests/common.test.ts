import { describe, expect, it } from "vitest";
import { paginationQuerySchema, paginatedResponseSchema, idSchema } from "../src/common.js";
import { z } from "zod";

describe("common helpers", () => {
  describe("idSchema", () => {
    it("accepts a cuid-shaped id", () => {
      expect(idSchema.parse("clxxxxxxxx0000abcd1234efgh")).toBe("clxxxxxxxx0000abcd1234efgh");
    });

    it("rejects an empty id", () => {
      expect(() => idSchema.parse("")).toThrow();
    });

    it("rejects a too-short id", () => {
      expect(() => idSchema.parse("short")).toThrow();
    });
  });

  describe("paginationQuerySchema", () => {
    it("defaults page=1 and pageSize=DEFAULT_PAGE_SIZE", () => {
      expect(paginationQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
    });

    it("coerces strings to numbers", () => {
      expect(paginationQuerySchema.parse({ page: "3", pageSize: "10" })).toEqual({
        page: 3,
        pageSize: 10,
      });
    });

    it("rejects pageSize above the cap", () => {
      expect(() => paginationQuerySchema.parse({ pageSize: 101 })).toThrow();
    });

    it("rejects page=0", () => {
      expect(() => paginationQuerySchema.parse({ page: 0 })).toThrow();
    });
  });

  describe("paginatedResponseSchema", () => {
    const schema = paginatedResponseSchema(z.object({ id: z.string() }));

    it("validates a well-formed envelope", () => {
      const value = { items: [{ id: "a" }], page: 1, pageSize: 10, total: 1 };
      expect(schema.parse(value)).toEqual(value);
    });

    it("rejects negative total", () => {
      expect(() => schema.parse({ items: [], page: 1, pageSize: 10, total: -1 })).toThrow();
    });
  });
});
