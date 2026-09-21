import { describe, expect, it } from "vitest";
import {
  assertParserCoversDmmfRelations,
  parsePrismaSchema,
  stripLineComment,
} from "./schema-fk-graph.js";

const SAMPLE = `
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Workspace {
  id        String   @id @default(cuid())
  name      String
  slug      String   @unique
  logoUrl   String?
  members   WorkspaceMember[]
  @@map("workspaces")
}

model WorkspaceMember {
  id          String    @id @default(cuid())
  workspaceId String
  userId      String
  role        String
  joinedAt    DateTime  @default(now())
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@map("workspace_members")
}

model User {
  id       String @id @default(cuid())
  email    String?
  members  WorkspaceMember[]
  invitesSent WorkspaceInvite[] @relation("WorkspaceInviter")
}

model WorkspaceInvite {
  id          String   @id @default(cuid())
  invitedById String
  invitedBy   User     @relation("WorkspaceInviter", fields: [invitedById], references: [id])
}
`;

describe("parsePrismaSchema", () => {
  const models = parsePrismaSchema(SAMPLE);

  it("parses all model blocks", () => {
    expect(models.map((m) => m.name).sort()).toEqual([
      "User",
      "Workspace",
      "WorkspaceInvite",
      "WorkspaceMember",
    ]);
  });

  it("resolves @@map table names, falling back to model name", () => {
    expect(models.find((m) => m.name === "Workspace")!.tableName).toBe("workspaces");
    expect(models.find((m) => m.name === "WorkspaceMember")!.tableName).toBe("workspace_members");
    // User has no @@map → falls back to model name.
    expect(models.find((m) => m.name === "User")!.tableName).toBe("User");
  });

  it("captures scalar fields with type, nullability, and id flag", () => {
    const ws = models.find((m) => m.name === "Workspace")!;
    const id = ws.scalarFields.find((f) => f.name === "id")!;
    expect(id.isId).toBe(true);
    expect(id.type).toBe("String");
    expect(id.isRequired).toBe(true);
    const logo = ws.scalarFields.find((f) => f.name === "logoUrl")!;
    expect(logo.isRequired).toBe(false);
    const joined = models
      .find((m) => m.name === "WorkspaceMember")!
      .scalarFields.find((f) => f.name === "joinedAt")!;
    expect(joined.type).toBe("DateTime");
  });

  it("does NOT include relation/back-reference fields as scalars", () => {
    const ws = models.find((m) => m.name === "Workspace")!;
    expect(ws.scalarFields.map((f) => f.name)).not.toContain("members");
    const wm = models.find((m) => m.name === "WorkspaceMember")!;
    expect(wm.scalarFields.map((f) => f.name)).not.toContain("workspace");
    expect(wm.scalarFields.map((f) => f.name)).not.toContain("user");
    // but the scalar FK columns ARE captured
    expect(wm.scalarFields.map((f) => f.name)).toContain("workspaceId");
    expect(wm.scalarFields.map((f) => f.name)).toContain("userId");
  });

  it("extracts owning-side FK edges with fields/references/referencedModel", () => {
    const wm = models.find((m) => m.name === "WorkspaceMember")!;
    const edges = [...wm.fkEdges].sort((a, b) => a.fieldName.localeCompare(b.fieldName));
    expect(edges).toHaveLength(2);
    const wsEdge = edges.find((e) => e.fieldName === "workspace")!;
    expect(wsEdge.referencedModel).toBe("Workspace");
    expect(wsEdge.fields).toEqual(["workspaceId"]);
    expect(wsEdge.references).toEqual(["id"]);
    expect(wsEdge.isRequired).toBe(true);
  });

  it('handles named relations (e.g. @relation("Name", fields: [...]))', () => {
    const inv = models.find((m) => m.name === "WorkspaceInvite")!;
    expect(inv.fkEdges).toHaveLength(1);
    expect(inv.fkEdges[0].referencedModel).toBe("User");
    expect(inv.fkEdges[0].fields).toEqual(["invitedById"]);
  });

  it("resolves a single @id field as the primary key", () => {
    expect(models.find((m) => m.name === "Workspace")!.primaryKey).toEqual(["id"]);
    expect(models.find((m) => m.name === "WorkspaceMember")!.primaryKey).toEqual(["id"]);
  });

  it("resolves a composite @@id([...]) as a multi-column primary key", () => {
    const schema = `
model RolePermission {
  roleId       String
  permissionId String
  role       Role       @relation(fields: [roleId], references: [id])
  permission Permission @relation(fields: [permissionId], references: [id])
  @@id([roleId, permissionId])
}`;
    const m = parsePrismaSchema(schema).find((x) => x.name === "RolePermission")!;
    expect(m.primaryKey).toEqual(["roleId", "permissionId"]);
    // The composite-id line is NOT misread as a scalar field.
    expect(m.scalarFields.map((f) => f.name)).toEqual(["roleId", "permissionId"]);
  });

  it("does not confuse @@id with a field-level @id", () => {
    const schema = `model X { roleId String\npermissionId String\n@@id([roleId, permissionId]) }`;
    const m = parsePrismaSchema(schema).find((x) => x.name === "X")!;
    expect(m.scalarFields.every((f) => f.isId === false)).toBe(true);
    expect(m.primaryKey).toEqual(["roleId", "permissionId"]);
  });

  it("treats an optional FK as not-required", () => {
    const schema = `
model A { id String @id }
model B {
  id String @id
  aId String?
  a   A? @relation(fields: [aId], references: [id])
}`;
    const m = parsePrismaSchema(schema).find((x) => x.name === "B")!;
    expect(m.fkEdges[0].isRequired).toBe(false);
  });
});

describe("parser loud guards (MAJOR 1 — parser fragility)", () => {
  it("THROWS on a reversed-argument-order owning @relation (references: before fields:)", () => {
    const schema = `
model A { id String @id }
model B {
  id  String @id
  aId String
  a   A @relation(references: [id], fields: [aId])
}`;
    expect(() => parsePrismaSchema(schema)).toThrow(/references: before fields:/);
  });

  it("THROWS on a multi-line @relation(...) block it does not model", () => {
    const schema = `
model A { id String @id }
model B {
  id  String @id
  aId String
  a   A @relation(
    fields: [aId],
    references: [id]
  )
}`;
    expect(() => parsePrismaSchema(schema)).toThrow(/multi-line @relation/);
  });

  it("THROWS on a field whose type is neither scalar, enum, nor a declared model", () => {
    // `Mystery` is not declared anywhere → cannot classify → must fail loudly.
    const schema = `
model B {
  id    String  @id
  thing Mystery
}`;
    expect(() => parsePrismaSchema(schema)).toThrow(/unrecognized type "Mystery"/);
  });

  it("captures a DECLARED enum field as a scalar (string round-trip) without throwing", () => {
    const schema = `
enum Status { ACTIVE INACTIVE }
model B {
  id     String @id
  status Status
}`;
    const m = parsePrismaSchema(schema).find((x) => x.name === "B")!;
    const status = m.scalarFields.find((f) => f.name === "status")!;
    expect(status.type).toBe("Status");
    expect(status.isRequired).toBe(true);
  });

  it("still skips an inverse-side relation object field (declared model, no @relation(fields:))", () => {
    const schema = `
model A {
  id String @id
  bs B[]
}
model B {
  id  String @id
  aId String
  a   A @relation(fields: [aId], references: [id])
}`;
    const a = parsePrismaSchema(schema).find((x) => x.name === "A")!;
    expect(a.scalarFields.map((f) => f.name)).not.toContain("bs");
    expect(a.fkEdges).toHaveLength(0);
  });
});

describe("stripLineComment (MAJOR 1 — //-in-string)", () => {
  it("strips a trailing // comment", () => {
    expect(stripLineComment("  id String @id // primary key").trim()).toBe("id String @id");
  });

  it("does NOT corrupt a // inside a quoted default (e.g. a URL)", () => {
    const line = '  baseUrl String @default("https://example.com/api")';
    expect(stripLineComment(line)).toBe(line);
  });

  it("strips a comment that appears AFTER a //-containing string default", () => {
    const line = '  baseUrl String @default("https://example.com") // env-specific';
    expect(stripLineComment(line).trim()).toBe('baseUrl String @default("https://example.com")');
  });

  it("parses a model whose default value contains // without dropping the field", () => {
    const schema = `
model Cfg {
  id      String @id
  baseUrl String @default("https://example.com/api")
}`;
    const m = parsePrismaSchema(schema).find((x) => x.name === "Cfg")!;
    expect(m.scalarFields.map((f) => f.name)).toEqual(["id", "baseUrl"]);
  });
});

describe("assertParserCoversDmmfRelations (MAJOR 1 — DMMF cross-check)", () => {
  const schema = `
model A {
  id String @id
  bs B[]
}
model B {
  id  String @id
  aId String
  a   A @relation(fields: [aId], references: [id])
}`;

  it("passes when every DMMF relation is owned or is a recognized inverse", () => {
    const parsed = parsePrismaSchema(schema);
    const dmmf = [
      { name: "A", fields: [{ name: "bs", kind: "object", type: "B" }] },
      {
        name: "B",
        fields: [
          { name: "a", kind: "object", type: "A" },
          { name: "aId", kind: "scalar", type: "String" },
        ],
      },
    ];
    expect(() => assertParserCoversDmmfRelations(parsed, dmmf)).not.toThrow();
  });

  it("THROWS when a DMMF relation has no owning edge on either side", () => {
    // Parser produced NO fkEdges for B.a (simulate a dropped owning relation).
    const parsedMissing = [
      { name: "A", tableName: "A", scalarFields: [], fkEdges: [], primaryKey: ["id"] },
      {
        name: "B",
        tableName: "B",
        scalarFields: [],
        fkEdges: [],
        primaryKey: ["id"],
      },
    ];
    const dmmf = [
      { name: "A", fields: [{ name: "bs", kind: "object", type: "B" }] },
      { name: "B", fields: [{ name: "a", kind: "object", type: "A" }] },
    ];
    expect(() => assertParserCoversDmmfRelations(parsedMissing, dmmf)).toThrow(
      /relation coverage check FAILED/,
    );
  });

  it("THROWS when a DMMF model is absent from the parsed set", () => {
    const parsed = parsePrismaSchema(schema);
    const dmmf = [
      { name: "A", fields: [] },
      { name: "B", fields: [] },
      { name: "Ghost", fields: [] },
    ];
    expect(() => assertParserCoversDmmfRelations(parsed, dmmf)).toThrow(/Ghost/);
  });
});
