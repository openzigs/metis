/**
 * Issue #896 (epic #883) — the framework-agnostic entity → physical-table
 * resolver. Covers the generic `MapEntityTableResolver` (the abstraction
 * SQLAlchemy-ORM #898 and EF-Core #900 will build their own factories
 * against) and the JPA/Hibernate factory that feeds it from
 * `parseJpaEntities` (#850).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildJpaEntityResolver,
  MapEntityTableResolver,
} from "../src/lib/code-graph/entity-resolver.js";

const customerJava = readFileSync(join(__dirname, "fixtures", "orm", "Customer.java"), "utf8");

describe("MapEntityTableResolver (generic)", () => {
  it("resolves an entity registered under one name", () => {
    const resolver = new MapEntityTableResolver();
    resolver.register("Widget", { table: "widgets", schema: "shop", fields: new Map() });
    expect(resolver.resolveEntity("Widget")).toEqual({ table: "widgets", schema: "shop" });
    // Case-insensitive.
    expect(resolver.resolveEntity("widget")).toEqual({ table: "widgets", schema: "shop" });
  });

  it("returns null for an unknown entity", () => {
    const resolver = new MapEntityTableResolver();
    expect(resolver.resolveEntity("Nope")).toBeNull();
  });

  it("falls back to the simple (last-segment) name when the exact ref isn't registered", () => {
    const resolver = new MapEntityTableResolver();
    resolver.register("Widget", { table: "widgets", fields: new Map() });
    expect(resolver.resolveEntity("com.example.Widget")).toEqual({ table: "widgets" });
  });

  it("re-registering the SAME name with a DIFFERENT table marks it ambiguous — never guesses", () => {
    const resolver = new MapEntityTableResolver();
    resolver.register("Widget", { table: "shop_widgets", fields: new Map() });
    resolver.register("Widget", { table: "legacy_widgets", fields: new Map() });
    expect(resolver.resolveEntity("Widget")).toBeNull();
  });

  it("re-registering the SAME name with the SAME table is a harmless no-op", () => {
    const resolver = new MapEntityTableResolver();
    resolver.register("Widget", { table: "widgets", fields: new Map() });
    resolver.register("Widget", { table: "widgets", fields: new Map() });
    expect(resolver.resolveEntity("Widget")).toEqual({ table: "widgets", schema: undefined });
  });

  it("resolveField returns the mapped column, or null for an unmapped/unknown field", () => {
    const resolver = new MapEntityTableResolver();
    resolver.register("Widget", {
      table: "widgets",
      schema: "shop",
      fields: new Map([["name", "widget_name"]]),
    });
    expect(resolver.resolveField("Widget", "name")).toEqual({
      table: "widgets",
      schema: "shop",
      column: "widget_name",
    });
    expect(resolver.resolveField("Widget", "unknownField")).toBeNull();
    expect(resolver.resolveField("Unknown", "name")).toBeNull();
  });

  it("resolveField returns null for an empty field name", () => {
    const resolver = new MapEntityTableResolver();
    resolver.register("Widget", { table: "widgets", fields: new Map([["name", "widget_name"]]) });
    expect(resolver.resolveField("Widget", "")).toBeNull();
  });

  it("resolveField on an ambiguous entity name returns null", () => {
    const resolver = new MapEntityTableResolver();
    resolver.register("Widget", { table: "a", fields: new Map([["x", "x"]]) });
    resolver.register("Widget", { table: "b", fields: new Map([["x", "x"]]) });
    expect(resolver.resolveField("Widget", "x")).toBeNull();
  });

  it("ignores an empty/undefined registration name", () => {
    const resolver = new MapEntityTableResolver();
    resolver.register("", { table: "widgets", fields: new Map() });
    resolver.register(undefined, { table: "widgets", fields: new Map() });
    expect(resolver.resolveEntity("")).toBeNull();
  });
});

describe("buildJpaEntityResolver (#896)", () => {
  const resolver = buildJpaEntityResolver(new Map([["Customer.java", customerJava]]));

  it("resolves the entity by simple class name to its @Table(name=, schema=)", () => {
    expect(resolver.resolveEntity("Customer")).toEqual({ table: "customers", schema: "crm" });
  });

  it("resolves the entity by its fully-qualified name too", () => {
    expect(resolver.resolveEntity("com.example.domain.Customer")).toEqual({
      table: "customers",
      schema: "crm",
    });
  });

  it("resolves an explicit @Column(name=) field to its column", () => {
    expect(resolver.resolveField("Customer", "email")).toEqual({
      table: "customers",
      schema: "crm",
      column: "email_address",
    });
  });

  it("resolves a bare field via the JPA snake_case default", () => {
    expect(resolver.resolveField("Customer", "displayName")).toEqual({
      table: "customers",
      schema: "crm",
      column: "display_name",
    });
  });

  it("resolves a @JoinColumn(name=) FK field", () => {
    expect(resolver.resolveField("Customer", "tenant")).toEqual({
      table: "customers",
      schema: "crm",
      column: "tenant_id",
    });
  });

  it("returns null for a @Transient field and for an unknown entity/field", () => {
    expect(resolver.resolveField("Customer", "fullName")).toBeNull();
    expect(resolver.resolveField("Customer", "doesNotExist")).toBeNull();
    expect(resolver.resolveEntity("NotAnEntity")).toBeNull();
  });

  it("supports an explicit @Entity(name=...) alias without touching orm-extractor.ts", () => {
    const aliased = [
      "package com.example.domain;",
      "",
      "import jakarta.persistence.Entity;",
      "import jakarta.persistence.Table;",
      "",
      '@Entity(name = "Cust")',
      '@Table(name = "customers")',
      "public class CustomerAlias {",
      "    private Long id;",
      "}",
      "",
    ].join("\n");
    const aliasedResolver = buildJpaEntityResolver(new Map([["CustomerAlias.java", aliased]]));
    expect(aliasedResolver.resolveEntity("Cust")).toEqual({
      table: "customers",
      schema: undefined,
    });
    // The class's own simple name still resolves too.
    expect(aliasedResolver.resolveEntity("CustomerAlias")).toEqual({
      table: "customers",
      schema: undefined,
    });
  });

  it("returns an empty resolver (never throws) for sources with no @Entity", () => {
    const empty = buildJpaEntityResolver(new Map([["Plain.java", "public class Plain {}"]]));
    expect(empty.resolveEntity("Plain")).toBeNull();
  });
});
