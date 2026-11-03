-- Issue #1725 — the host product of a portfolio assessment (Postgres twin of
-- server/prisma/migrations/20261111001725_issue1725_portfolio_host_product).
--
-- Nullable TEXT, no foreign key (the record outlives the product); every
-- existing row reads as "no host chosen". Idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261111001725_issue1725_portfolio_host_product.sql

ALTER TABLE "portfolio_assessments" ADD COLUMN IF NOT EXISTS "hostProductId" TEXT;
