/**
 * Barrel router for `/api/admin/*` routes (Epic #249).
 *
 * Phase 2 (#257) consolidates the secrets-write and audit-log routes into a
 * single unified config router that handles GET/PUT/DELETE for both Tier-2
 * secrets and Tier-3 tunables, plus paginated audit reads.
 */
import { Router } from "express";
import { configRouter } from "./config.js";
import { adminAuthRouter } from "./auth.js";
import { embeddingsAdminRouter } from "./embeddings.js";
import { cacheTelemetryRouter } from "./cache-telemetry.js";
import { adminUsageRouter, adminTokenBudgetRouter } from "../usage.js";

export function adminRouter(): Router {
  const r = Router();
  r.use("/config", configRouter());
  // Epic #748 — SSO provider administration.
  r.use("/auth", adminAuthRouter());
  // Epic #594 — admin usage dashboard + token budget management.
  r.use("/usage", adminUsageRouter());
  r.use("/token-budgets", adminTokenBudgetRouter());
  // Epic #930 — pluggable embeddings backend admin (capabilities/health/reindex).
  r.use("/embeddings", embeddingsAdminRouter());
  // Epic #696 (#699) — read-only prompt-cache hit-ratio telemetry snapshot.
  r.use("/cache-telemetry", cacheTelemetryRouter());
  return r;
}
