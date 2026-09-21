-- Epic #856 Phase 2 — Issue #878 — Per-phase token telemetry columns.
ALTER TABLE "test_coverage_runs" ADD COLUMN "embeddingTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "test_coverage_runs" ADD COLUMN "judgeTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "test_coverage_runs" ADD COLUMN "suggestionTokens" INTEGER NOT NULL DEFAULT 0;
