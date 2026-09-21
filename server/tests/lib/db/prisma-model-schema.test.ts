/**
 * Issue #1330 — the validating fake's own red paths.
 *
 * A fake that silently accepts everything is what this replaces, so the fake
 * itself must be shown to reject. Each case here fails when the corresponding
 * guard in `prisma-model-schema.ts` is removed.
 */
import { describe, expect, it } from "vitest";
import {
  creatableKeys,
  makeValidatingCreateFake,
  parsePrismaModel,
  readSchemaText,
  requiredCreateKeys,
} from "./prisma-model-schema.js";

const SYNTHETIC = `
model Widget {
  id        String   @id @default(cuid())
  ownerId   String?
  name      String
  body      String
  size      Int      @default(1)
  tags      String[]
  owner     Owner?   @relation(fields: [ownerId], references: [id])
  createdAt DateTime @default(now())

  @@index([ownerId])
  @@map("widgets")
}
`;

describe("parsePrismaModel", () => {
  it("reads scalars, optionality, defaults, lists and relations", () => {
    const fields = parsePrismaModel(SYNTHETIC, "Widget");
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.id).toMatchObject({ type: "String", hasDefault: true, relation: false });
    expect(byName.ownerId).toMatchObject({ optional: true, hasDefault: false });
    expect(byName.tags).toMatchObject({ list: true });
    expect(byName.owner).toMatchObject({ relation: true, optional: true });
    expect(requiredCreateKeys(fields).sort()).toEqual(["body", "name"]);
  });

  it("THROWS on an absent model rather than returning an empty field list", () => {
    expect(() => parsePrismaModel(SYNTHETIC, "Nonexistent")).toThrow(/not found/);
  });

  it("THROWS when a model block parses to zero fields", () => {
    expect(() => parsePrismaModel('model Empty {\n  @@map("empty")\n}\n', "Empty")).toThrow(
      /zero fields/,
    );
  });

  it("does not confuse a model whose name is a prefix of another", () => {
    const text = `${SYNTHETIC}\nmodel WidgetPart {\n  id String @id\n  partOnly String\n}\n`;
    expect(creatableKeys(parsePrismaModel(text, "Widget")).has("partOnly")).toBe(false);
  });
});

describe("makeValidatingCreateFake", () => {
  const fields = parsePrismaModel(SYNTHETIC, "Widget");
  const fake = () => makeValidatingCreateFake(fields, { modelName: "Widget", returnId: "w-1" });

  it("accepts a payload the model actually supports", async () => {
    const create = fake();
    await expect(create({ data: { name: "n", body: "b" } })).resolves.toEqual({ id: "w-1" });
    expect(create.calls).toHaveLength(1);
  });

  it("REJECTS a column the model does not have", async () => {
    await expect(fake()({ data: { name: "n", body: "b", nope: 1 } })).rejects.toThrow(
      /Unknown argument `nope`/,
    );
  });

  it("REJECTS a missing required column", async () => {
    await expect(fake()({ data: { name: "n" } })).rejects.toThrow(/Argument `body` is missing/);
  });

  it("does not record a rejected payload as a call", async () => {
    const create = fake();
    await expect(create({ data: { name: "n" } })).rejects.toThrow();
    expect(create.calls).toHaveLength(0);
  });
});

describe("the real Finding model (the subject of #1330)", () => {
  const fields = parsePrismaModel(readSchemaText(), "Finding");

  it("requires exactly title, body and category on create", () => {
    expect(requiredCreateKeys(fields).sort()).toEqual(["body", "category", "title"]);
  });

  it("has none of the five columns the pre-#1330 payload wrote", () => {
    const keys = creatableKeys(fields);
    for (const bogus of ["projectId", "description", "source", "metadata", "createdById"]) {
      expect(keys.has(bogus), `Finding must not have a \`${bogus}\` column`).toBe(false);
    }
  });

  it("carries the scan-finding back-link and a NULLABLE agentResultId (ADR 0011)", () => {
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.scanFindingId).toMatchObject({ type: "String", optional: true });
    expect(byName.agentResultId, "#1330 — must be nullable").toMatchObject({ optional: true });
  });
});
