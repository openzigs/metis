/**
 * Tests for Epic #486 / Issue #488 — Formula & Business Rule Extractor.
 */
import { describe, it, expect } from "vitest";
import { extractFormulas } from "../../src/lib/code-graph/formula-extractor.js";

describe("extractFormulas", () => {
  describe("TypeScript/JavaScript extraction", () => {
    it("extracts UPPER_CASE constants", () => {
      const source = `const MAX_RETRIES = 3;\nconst TIMEOUT_MS = 5000;\nlet foo = "bar";`;
      const result = extractFormulas(source, "test.ts", "ts");
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        kind: "constant",
        name: "MAX_RETRIES",
        resolvedValue: "3",
      });
      expect(result[1]).toMatchObject({
        kind: "constant",
        name: "TIMEOUT_MS",
        resolvedValue: "5000",
      });
    });

    it("extracts exported constants", () => {
      const source = `export const API_VERSION = "v2";\nexport const RATE_LIMIT = 100;`;
      const result = extractFormulas(source, "config.ts", "ts");
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("API_VERSION");
      expect(result[1].name).toBe("RATE_LIMIT");
    });

    it("extracts arithmetic formulas", () => {
      const source = `const total = price * quantity + taxRate * price;\nconst name = "hello";`;
      const result = extractFormulas(source, "calc.ts", "ts");
      const arithmetic = result.filter((f) => f.kind === "arithmetic");
      expect(arithmetic).toHaveLength(1);
      expect(arithmetic[0].name).toBe("total");
      expect(arithmetic[0].expression).toContain("*");
    });

    it("extracts business rule conditionals", () => {
      const source = `if (amount > threshold && amount < maxLimit) {\n  applyDiscount();\n}`;
      const result = extractFormulas(source, "rules.ts", "ts");
      const rules = result.filter((f) => f.kind === "business-rule");
      expect(rules).toHaveLength(1);
      expect(rules[0].description).toBe("Threshold check");
    });

    it("extracts validation patterns (typeof check)", () => {
      const source = `if (typeof value === "string") {\n  process(value);\n}`;
      const result = extractFormulas(source, "validate.ts", "ts");
      const validations = result.filter((f) => f.kind === "validation");
      expect(validations).toHaveLength(1);
      expect(validations[0].description).toBe("Type check");
    });

    it("ignores trivial assignments", () => {
      const source = `const x = 5;\nlet name = getName();`;
      const result = extractFormulas(source, "simple.ts", "ts");
      // Only 'x' doesn't match UPPER_CASE, and is too short for arithmetic
      expect(result.every((f) => f.kind === "constant" || f.expression.length > 10)).toBe(true);
    });

    it("handles empty source", () => {
      const result = extractFormulas("", "empty.ts", "ts");
      expect(result).toHaveLength(0);
    });
  });

  describe("Java extraction", () => {
    it("extracts final constants", () => {
      const source = `private static final int MAX_CONNECTIONS = 50;\npublic static final double TAX_RATE = 0.07;`;
      const result = extractFormulas(source, "Config.java", "java");
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        kind: "constant",
        name: "MAX_CONNECTIONS",
        resolvedValue: "50",
      });
      expect(result[1]).toMatchObject({
        kind: "constant",
        name: "TAX_RATE",
        resolvedValue: "0.07",
      });
    });

    it("extracts arithmetic in Java", () => {
      const source = `double interest = principal * rate / 100.0;`;
      const result = extractFormulas(source, "Calc.java", "java");
      const arithmetic = result.filter((f) => f.kind === "arithmetic");
      expect(arithmetic).toHaveLength(1);
      expect(arithmetic[0].name).toBe("interest");
    });
  });

  describe("Python extraction", () => {
    it("extracts Python constants", () => {
      const source = `MAX_WORKERS = 8\nDEFAULT_TIMEOUT = 30.0`;
      const result = extractFormulas(source, "config.py", "py");
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("MAX_WORKERS");
      expect(result[1].name).toBe("DEFAULT_TIMEOUT");
    });

    it("extracts Python arithmetic", () => {
      const source = `total_cost = base_price * quantity + shipping_fee`;
      const result = extractFormulas(source, "calc.py", "py");
      const arithmetic = result.filter((f) => f.kind === "arithmetic");
      expect(arithmetic).toHaveLength(1);
    });
  });

  describe("Go extraction", () => {
    it("extracts Go constants", () => {
      const source = `MaxRetries = 5\nDefaultPort = 8080`;
      const result = extractFormulas(source, "config.go", "go");
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result.some((f) => f.name === "MaxRetries")).toBe(true);
    });
  });

  describe("source location tracking", () => {
    it("reports correct line numbers", () => {
      const source = `// header\nconst MAX_SIZE = 1024;\n// footer`;
      const result = extractFormulas(source, "test.ts", "ts");
      expect(result[0].startLine).toBe(2);
      expect(result[0].endLine).toBe(2);
      expect(result[0].filePath).toBe("test.ts");
    });
  });
});
