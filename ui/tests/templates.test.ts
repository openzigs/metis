import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeRunPayload,
  extractVariables,
  stashRunPayload,
  substitute,
  templatesStore,
} from "@/lib/templates";

describe("templates", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  describe("extractVariables", () => {
    it("returns each variable once in order", () => {
      expect(extractVariables("Hello {{name}}, your ticket {{ticket}} ({{name}})")).toEqual([
        "name",
        "ticket",
      ]);
    });
    it("handles whitespace around variable names", () => {
      expect(extractVariables("{{ foo }} and {{bar}}")).toEqual(["foo", "bar"]);
    });
    it("returns empty list when no variables", () => {
      expect(extractVariables("plain text")).toEqual([]);
    });
  });

  describe("substitute", () => {
    it("substitutes all values when no required vars", () => {
      expect(substitute("Hi {{name}}", { name: "Ada" }, [])).toBe("Hi Ada");
    });
    it("throws when a required var is missing", () => {
      expect(() => substitute("{{x}}", {}, ["x"])).toThrow(/Missing required variables: x/);
    });
    it("throws when a required var is whitespace-only", () => {
      expect(() => substitute("{{x}}", { x: "   " }, ["x"])).toThrow(/Missing required/);
    });
    it("leaves missing optional vars as empty string", () => {
      expect(substitute("[{{a}}][{{b}}]", { a: "1" }, [])).toBe("[1][]");
    });
  });

  describe("templatesStore", () => {
    it("creates and lists templates (newest first)", () => {
      const a = templatesStore.create({ name: "A", body: "x" });
      const b = templatesStore.create({ name: "B", body: "y" });
      const list = templatesStore.list();
      expect(list[0]?.id).toBe(b.id);
      expect(list[1]?.id).toBe(a.id);
    });
    it("get returns undefined for unknown id", () => {
      expect(templatesStore.get("missing")).toBeUndefined();
    });
    it("update preserves id and createdAt and refreshes updatedAt", async () => {
      const t = templatesStore.create({ name: "A", body: "{{x}}", required: ["x"] });
      await new Promise((r) => setTimeout(r, 5));
      const updated = templatesStore.update(t.id, { name: "A2", body: "{{y}}", required: ["y"] });
      expect(updated?.id).toBe(t.id);
      expect(updated?.createdAt).toBe(t.createdAt);
      expect(updated?.updatedAt).not.toBe(t.updatedAt);
      expect(updated?.required).toEqual(["y"]);
    });
    it("update strips required vars not present in the new body", () => {
      const t = templatesStore.create({ name: "A", body: "{{x}}", required: ["x"] });
      const updated = templatesStore.update(t.id, { body: "no vars" });
      expect(updated?.required).toEqual([]);
    });
    it("update returns undefined for unknown id", () => {
      expect(templatesStore.update("missing", { name: "x" })).toBeUndefined();
    });
    it("create only persists required vars that are detected", () => {
      const t = templatesStore.create({
        name: "A",
        body: "{{a}} {{b}}",
        required: ["a", "ghost"],
      });
      expect(t.required).toEqual(["a"]);
    });
    it("remove returns false for unknown id", () => {
      expect(templatesStore.remove("missing")).toBe(false);
    });
    it("remove drops the entry", () => {
      const t = templatesStore.create({ name: "A", body: "x" });
      expect(templatesStore.remove(t.id)).toBe(true);
      expect(templatesStore.list()).toEqual([]);
    });
    it("clear empties the store", () => {
      templatesStore.create({ name: "A", body: "x" });
      templatesStore.clear();
      expect(templatesStore.list()).toEqual([]);
    });
    it("ignores malformed stored entries", () => {
      window.localStorage.setItem(
        "metis.library.templates",
        JSON.stringify([{ id: "ok", name: "n", body: "b", required: [] }, { broken: true }]),
      );
      expect(templatesStore.list().length).toBe(1);
    });
    it("returns empty list on bad JSON", () => {
      window.localStorage.setItem("metis.library.templates", "not json");
      expect(templatesStore.list()).toEqual([]);
    });
  });

  describe("run payload hand-off", () => {
    it("round-trips a payload via sessionStorage", () => {
      stashRunPayload({ prompt: "go", templateId: "t1", templateName: "T" });
      const consumed = consumeRunPayload();
      expect(consumed?.prompt).toBe("go");
      // consume clears the storage
      expect(consumeRunPayload()).toBeNull();
    });
    it("returns null when nothing is stashed", () => {
      expect(consumeRunPayload()).toBeNull();
    });
    it("returns null when payload is malformed", () => {
      window.sessionStorage.setItem("metis.library.pendingRun", "not json");
      expect(consumeRunPayload()).toBeNull();
    });
    it("returns null when required keys are missing", () => {
      window.sessionStorage.setItem("metis.library.pendingRun", JSON.stringify({ prompt: 1 }));
      expect(consumeRunPayload()).toBeNull();
    });
  });
});
