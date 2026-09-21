/**
 * Products rate limiter tests (Epic #544).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  productsRateLimiter,
  __resetProductsRateLimiter,
} from "../middleware/products-rate-limit.js";

describe("productsRateLimiter", () => {
  let app: express.Express;

  beforeEach(() => {
    process.env.PRODUCTS_RATE_LIMIT_MAX = "3";
    process.env.PRODUCTS_RATE_LIMIT_WINDOW_MS = "60000";
    __resetProductsRateLimiter();

    app = express();
    app.use(productsRateLimiter);
    app.get("/", (_req, res) => res.json({ ok: true }));
  });

  afterEach(() => {
    delete process.env.PRODUCTS_RATE_LIMIT_MAX;
    delete process.env.PRODUCTS_RATE_LIMIT_WINDOW_MS;
    __resetProductsRateLimiter();
  });

  it("allows requests under the limit", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
  });

  it("returns 429 after exceeding the limit", async () => {
    await request(app).get("/");
    await request(app).get("/");
    await request(app).get("/");
    const res = await request(app).get("/");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("PRODUCTS_RATE_LIMITED");
  });
});
