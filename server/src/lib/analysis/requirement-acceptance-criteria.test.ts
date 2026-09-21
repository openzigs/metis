/**
 * Issue #1096 — `requirements.acceptanceCriteria` migration + contract sanity.
 *
 * Mirrors the #736 coverage-column guard: the column must exist in BOTH the
 * SQLite and Postgres incremental migrations, the Postgres ADD COLUMN must be
 * idempotent (issue #556 from-scratch deploy over the cumulative init baseline),
 * the init baseline must already carry it, and both Prisma schemas must declare
 * the field.
 *
 * It also pins the two halves of the contract that make the fix real: the
 * synthesis prompt ASKS for criteria and forbids filler, and the schema accepts
 * an empty array as a valid "none derived" answer instead of coercing one in.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { synthesizedRequirementSchema, parseAcceptanceCriteria } from "@metis/shared";
import { buildSynthesisPrompt } from "./prompts.js";

const repoRoot = join(import.meta.dirname ?? __dirname, "..", "..", "..", "..");
const MIG = "20260727000000_issue1096_requirement_acceptance_criteria";

const sqliteMigration = readFileSync(
  join(repoRoot, "server/prisma/migrations", MIG, "migration.sql"),
  "utf-8",
);
const postgresMigration = readFileSync(
  join(repoRoot, "server/prisma/postgres/migrations", MIG, "migration.sql"),
  "utf-8",
);
const sqliteSchema = readFileSync(join(repoRoot, "server/prisma/schema.prisma"), "utf-8");
const postgresSchema = readFileSync(
  join(repoRoot, "server/prisma/postgres/schema.prisma"),
  "utf-8",
);
const postgresInit = readFileSync(
  join(repoRoot, "server/prisma/postgres/migrations/00000000000000_init/migration.sql"),
  "utf-8",
);

describe("requirement acceptanceCriteria migration (#1096)", () => {
  it("SQLite migration adds the column with a '[]' default", () => {
    expect(sqliteMigration).toContain(
      `ALTER TABLE "requirements" ADD COLUMN "acceptanceCriteria" TEXT NOT NULL DEFAULT '[]'`,
    );
  });

  it("Postgres migration adds the column idempotently (issue #556)", () => {
    expect(postgresMigration).toContain(
      `ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "acceptanceCriteria" TEXT NOT NULL DEFAULT '[]'`,
    );
  });

  it("the cumulative Postgres init baseline carries the column (parity guard)", () => {
    const createReq = postgresInit.slice(postgresInit.indexOf('CREATE TABLE "requirements"'));
    const body = createReq.slice(0, createReq.indexOf(");"));
    expect(body).toContain(`"acceptanceCriteria" TEXT NOT NULL DEFAULT '[]'`);
  });

  it("both Prisma schemas declare acceptanceCriteria on the Requirement model", () => {
    for (const s of [sqliteSchema, postgresSchema]) {
      const model = s.slice(s.indexOf("model Requirement {"));
      const body = model.slice(0, model.indexOf("}"));
      expect(body).toMatch(/acceptanceCriteria\s+String\s+@default\("\[\]"\)/);
    }
  });
});

describe("synthesized requirement contract (#1096)", () => {
  it("accepts model-derived criteria", () => {
    const parsed = synthesizedRequirementSchema.parse({
      title: "Enforce inventory availability at checkout",
      body: "Stock is decremented after the order is written.",
      acceptanceCriteria: ["INVENTORY.QTY can never go below zero."],
      evidenceFindingIndexes: [0],
    });
    expect(parsed.acceptanceCriteria).toEqual(["INVENTORY.QTY can never go below zero."]);
  });

  it("defaults to an empty array — a truthful 'none derived', not filler", () => {
    const parsed = synthesizedRequirementSchema.parse({ title: "t", body: "b" });
    expect(parsed.acceptanceCriteria).toEqual([]);
  });

  it("parses the persisted column and rejects junk without inventing criteria", () => {
    expect(parseAcceptanceCriteria(JSON.stringify(["a", "b"]))).toEqual(["a", "b"]);
    expect(parseAcceptanceCriteria(JSON.stringify(["  ", "keep me"]))).toEqual(["keep me"]);
    expect(parseAcceptanceCriteria("[]")).toEqual([]);
    expect(parseAcceptanceCriteria("{not json")).toEqual([]);
    expect(parseAcceptanceCriteria(JSON.stringify({ a: 1 }))).toEqual([]);
    expect(parseAcceptanceCriteria(null)).toEqual([]);
  });
});

describe("synthesis prompt (#1096)", () => {
  const { systemMessage } = buildSynthesisPrompt({
    projectName: "JPetStore",
    findingsTable: "[0] (code) Stock decremented after order write :: ...",
  });

  it("asks for acceptance criteria in the response shape", () => {
    expect(systemMessage).toContain(`"acceptanceCriteria"`);
  });

  it("requires them to be derived from evidence and forbids generic filler", () => {
    expect(systemMessage).toMatch(/derived from THIS requirement's own evidence/);
    expect(systemMessage).toMatch(/return an EMPTY array/);
    expect(systemMessage).toMatch(/never emit generic filler/i);
    // The exact phrases the old placeholder used are named as prohibited.
    expect(systemMessage).toContain("the change ships");
  });
});
