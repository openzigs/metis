import { describe, expect, it } from "vitest";
import {
  PERMISSION_KEYS,
  ROLE_KEYS,
  MAX_DOCUMENT_BYTES,
  MAX_QUERY_ROWS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_BATCH_ISSUES,
  DEFAULT_MAX_TASK_ATTEMPTS,
  DEFAULT_TASK_PRIORITY,
} from "../src/constants.js";

describe("constants", () => {
  it("ships the four canonical role keys in order", () => {
    expect(ROLE_KEYS).toEqual(["admin", "coordinator", "developer", "reader"]);
  });

  it("permission keys are unique and namespaced", () => {
    const set = new Set(PERMISSION_KEYS);
    expect(set.size).toBe(PERMISSION_KEYS.length);
    for (const key of PERMISSION_KEYS) {
      // Allow up to three dot-separated segments (e.g. `pr.review.read`).
      expect(key).toMatch(/^[a-z]+(?:\.[a-z_]+){1,2}$/);
    }
  });

  it("limit constants have sane numeric values", () => {
    expect(MAX_DOCUMENT_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_QUERY_ROWS).toBe(100);
    expect(DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    expect(MAX_BATCH_ISSUES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_TASK_ATTEMPTS).toBeGreaterThan(0);
    expect(DEFAULT_TASK_PRIORITY).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_TASK_PRIORITY).toBeLessThanOrEqual(10);
  });
});
