import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractOrm,
  parseJpaEntities,
  parsePrismaModels,
  persistOrmFile,
  toSnakeCase,
} from "../src/lib/code-graph/orm-extractor.js";
import {
  SchemaGraphWriter,
  type SchemaEdgeCreateData,
  type SchemaGraphPrisma,
  type SchemaSymbolCreateData,
} from "../src/lib/code-graph/schema-graph.js";

const FIX = join(__dirname, "fixtures", "orm");
const javaSrc = readFileSync(join(FIX, "Customer.java"), "utf8");
const prismaSrc = readFileSync(join(FIX, "schema.prisma"), "utf8");

function fakeWriter(): {
  writer: SchemaGraphWriter;
  symbols: SchemaSymbolCreateData[];
  edges: SchemaEdgeCreateData[];
} {
  const symbols: SchemaSymbolCreateData[] = [];
  const edges: SchemaEdgeCreateData[] = [];
  let n = 0;
  const prisma: SchemaGraphPrisma = {
    codeSymbol: {
      create: async ({ data }) => {
        symbols.push(data);
        return { id: `${data.kind}-${++n}` };
      },
    },
    codeEdge: {
      create: async ({ data }) => {
        edges.push(data);
        return undefined;
      },
    },
  };
  return { writer: new SchemaGraphWriter(prisma, "g", "p"), symbols, edges };
}

describe("toSnakeCase", () => {
  it("converts camelCase to snake_case", () => {
    expect(toSnakeCase("displayName")).toBe("display_name");
    expect(toSnakeCase("HTTPServer")).toBe("http_server");
    expect(toSnakeCase("id")).toBe("id");
  });
});

describe("parseJpaEntities", () => {
  const [customer] = parseJpaEntities(javaSrc);

  it("maps the entity onto its @Table name and schema", () => {
    expect(customer.entityName).toBe("com.example.domain.Customer");
    expect(customer.table).toBe("customers");
    expect(customer.schema).toBe("crm");
  });

  it("maps @Column overrides and snake-cases bare fields", () => {
    const cols = customer.fields.map((f) => f.column);
    expect(cols).toContain("email_address");
    expect(cols).toContain("display_name");
    expect(cols).toContain("id");
  });

  it("uses @JoinColumn for a ManyToOne FK", () => {
    expect(customer.fields.map((f) => f.column)).toContain("tenant_id");
  });

  it("ignores @Transient and unjoined @OneToMany collections", () => {
    const fields = customer.fields.map((f) => f.field);
    expect(fields).not.toContain("fullName");
    expect(fields).not.toContain("orders");
  });

  it("returns nothing for a non-entity file", () => {
    expect(parseJpaEntities("class Plain {}")).toEqual([]);
  });
});

describe("parsePrismaModels", () => {
  const models = parsePrismaModels(prismaSrc);

  it("maps @@map table names", () => {
    const account = models.find((m) => m.entityName === "Account");
    expect(account?.table).toBe("accounts");
  });

  it("maps @map column overrides and keeps scalar fields", () => {
    const account = models.find((m) => m.entityName === "Account");
    const cols = account?.fields.map((f) => f.column) ?? [];
    expect(cols).toContain("full_name");
    expect(cols).toContain("created_at");
    expect(cols).toContain("org_id");
    expect(cols).toContain("email");
  });

  it("drops relation virtual fields", () => {
    const account = models.find((m) => m.entityName === "Account");
    const fields = account?.fields.map((f) => f.field) ?? [];
    expect(fields).not.toContain("posts");
    expect(fields).not.toContain("org");
  });

  it("defaults table name to the model name when unmapped", () => {
    const post = models.find((m) => m.entityName === "Post");
    expect(post?.table).toBe("post");
  });
});

describe("extractOrm dispatch", () => {
  it("routes .java to JPA and .prisma to Prisma", () => {
    expect(extractOrm("Customer.java", javaSrc).length).toBe(1);
    expect(extractOrm("schema.prisma", prismaSrc).length).toBe(2);
    expect(extractOrm("notes.txt", "x")).toEqual([]);
  });
});

describe("persistOrmFile", () => {
  it("writes persists-to edges with source orm", async () => {
    const { writer, symbols, edges } = fakeWriter();
    const count = await persistOrmFile(writer, "Customer.java", javaSrc);
    expect(count).toBeGreaterThan(0);
    expect(edges.every((e) => e.kind === "persists-to")).toBe(true);
    expect(edges.every((e) => e.source === "orm")).toBe(true);
    expect(symbols.some((s) => s.kind === "table" && s.qualifiedName === "crm.customers")).toBe(
      true,
    );
    expect(symbols.some((s) => s.kind === "column" && s.name === "email_address")).toBe(true);
  });

  it("writes nothing for an unsupported file", async () => {
    const { writer, edges } = fakeWriter();
    expect(await persistOrmFile(writer, "x.txt", "nope")).toBe(0);
    expect(edges).toHaveLength(0);
  });
});
