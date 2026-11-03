/**
 * Tests for Epic #486 / Issue #488 — Formula & Business Rule Extractor.
 */
import { describe, it, expect } from "vitest";
import { extractFormulas } from "../../src/lib/code-graph/formula-extractor.js";
import { expectLinearTime } from "../helpers/linear-time.js";

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

  // #1578 — run 10 read `GenerateRandomStringHex(32)` as a 32-character
  // string; it returns 64. The call is recorded with the length it returns.
  describe("hex-encoded lengths (#1578)", () => {
    const hex = (source: string, file: string, lang: Parameters<typeof extractFormulas>[2]) =>
      extractFormulas(source, file, lang).filter((f) => f.encodedLength);

    it("records a Go random-hex helper's byte count and the length it returns", () => {
      const source = [
        "func (h *handler) createAPIKey() {",
        "\ttoken := crypto.GenerateRandomStringHex(32)",
        "\tshareCode := crypto.GenerateRandomStringHex(20) // share link",
        "}",
      ].join("\n");
      const result = hex(source, "internal/api/api_key.go", "go");
      expect(result).toEqual([
        expect.objectContaining({
          kind: "constant",
          expression: "GenerateRandomStringHex(32)",
          name: null,
          resolvedValue: "64",
          description: "32 bytes, hex-encoded as 64 characters",
          startLine: 2,
          encodedLength: { encoding: "hex", bytes: 32, characters: 64 },
        }),
        expect.objectContaining({
          expression: "GenerateRandomStringHex(20)",
          startLine: 3,
          encodedLength: { encoding: "hex", bytes: 20, characters: 40 },
        }),
      ]);
    });

    it("reads Python token_hex and .hex() of random bytes, and Node randomBytes(n).toString('hex')", () => {
      const py = hex(
        "state = secrets.token_hex(16)\nnonce = os.urandom(12).hex()\nsalt = secrets.token_bytes(8).hex()",
        "auth.py",
        "py",
      );
      expect(py.map((f) => f.encodedLength)).toEqual([
        { encoding: "hex", bytes: 16, characters: 32 },
        { encoding: "hex", bytes: 12, characters: 24 },
        { encoding: "hex", bytes: 8, characters: 16 },
      ]);
      const ts = hex(`const verifier = crypto.randomBytes(32).toString("hex");`, "pkce.ts", "ts");
      expect(ts.map((f) => [f.expression, f.encodedLength?.characters])).toEqual([
        [`randomBytes(32).toString("hex")`, 64],
      ]);
    });

    it("leaves alone a helper that names no random value, a variable byte count, a definition and a comment", () => {
      const source = [
        "s := strconv.toHex(32)",
        "token := crypto.GenerateRandomStringHex(keyLength)",
        "func GenerateRandomStringHex(size int) string {",
        "// crypto.GenerateRandomStringHex(32) in the old code",
        "x := crypto.GenerateRandomStringHex(0)",
      ].join("\n");
      expect(hex(source, "internal/crypto/crypto.go", "go")).toEqual([]);
    });

    it("is read for a language without its own extractor too", () => {
      const result = hex("val key = Tokens.randomTokenHex(24)", "Keys.kt", "kt");
      expect(result.map((f) => f.encodedLength?.characters)).toEqual([48]);
    });

    it("reads a long line in linear time", () => {
      expectLinearTime("extractFormulas: hex helper names", (size) => {
        const text = `${"aRandomTokenHexxxxx".repeat(Math.ceil(size / 19))}(1`;
        return () => extractFormulas(text, "x.go", "go");
      });
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
