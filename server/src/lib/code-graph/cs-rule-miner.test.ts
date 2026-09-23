/**
 * Unit tests for the C# rule miner (#158).
 *
 * One fixture per rule kind, plus the false-positive guards the issue names:
 * a logging-only `if` is not a rule, whatever its condition compares against.
 */
import { describe, expect, it } from "vitest";
import { mineCsRules, renderMinedCsRules, type MinedCsRule } from "./cs-rule-miner.js";

const FILE = "src/Orders/OrderService.cs";

function byKind(rules: MinedCsRule[], k: MinedCsRule["kind"]): MinedCsRule[] {
  return rules.filter((r) => r.kind === k);
}

describe("mineCsRules — guard clauses", () => {
  it("mines an Allman-braced if whose body throws, with the correct line", () => {
    const src = [
      `public void Place(Order order)`,
      `{`,
      `    if (order.Total <= 0)`,
      `    {`,
      `        throw new ValidationException("Order total must be positive");`,
      `    }`,
      `}`,
    ].join("\n");
    const rules = mineCsRules(src, FILE, 10, "OrderService.Place");
    const g = byKind(rules, "guard");
    expect(g).toHaveLength(1);
    expect(g[0].summary).toBe("Rejects/exits when order.Total <= 0");
    expect(g[0].line).toBe(12);
    expect(g[0].context).toBe("OrderService.Place");
    expect(g[0].filePath).toBe(FILE);
  });

  it("mines a K&R-braced guard that returns early", () => {
    const src = [`if (customer == null) {`, `    return Result.Fail("no customer");`, `}`].join(
      "\n",
    );
    const g = byKind(mineCsRules(src, FILE, 1), "guard");
    expect(g.map((r) => r.summary)).toEqual(["Rejects/exits when customer == null"]);
  });

  it("mines an unbraced single-statement guard on the next line", () => {
    const src = [`if (string.IsNullOrWhiteSpace(sku))`, `    return false;`].join("\n");
    const g = byKind(mineCsRules(src, FILE, 1), "guard");
    expect(g.map((r) => r.summary)).toEqual(["Rejects/exits when string.IsNullOrWhiteSpace(sku)"]);
  });

  it("mines an inline guard and also records the throw it carries", () => {
    const rules = mineCsRules(
      `if (qty > MaxQuantity) throw new ArgumentOutOfRangeException(nameof(qty));`,
      FILE,
      1,
    );
    expect(byKind(rules, "guard").map((r) => r.summary)).toEqual([
      "Rejects when qty > MaxQuantity",
    ]);
    expect(byKind(rules, "throw").map((r) => r.summary)).toEqual([
      "Throws ArgumentOutOfRangeException",
    ]);
  });

  it("does not treat an ordinary non-exiting, non-threshold if as a rule", () => {
    const src = [`if (order.IsGift)`, `{`, `    order.Wrap();`, `}`].join("\n");
    expect(byKind(mineCsRules(src, FILE, 1), "guard")).toHaveLength(0);
  });
});

describe("mineCsRules — constants in comparisons", () => {
  it("mines a branch on a named constant and on an enum member", () => {
    const src = [
      `if (order.Total >= FreeShippingThreshold)`,
      `{`,
      `    order.ShippingFee = 0;`,
      `}`,
      `if (order.Status == OrderStatus.Cancelled)`,
      `{`,
      `    Refund(order);`,
      `}`,
    ].join("\n");
    const g = byKind(mineCsRules(src, FILE, 1), "guard");
    expect(g.map((r) => r.summary)).toEqual([
      "Branches on threshold order.Total >= FreeShippingThreshold",
      "Branches on threshold order.Status == OrderStatus.Cancelled",
    ]);
  });

  it("mines a literal threshold in an inline statement if and in a ternary", () => {
    const rules = mineCsRules(
      [`if (points > 1000) Upgrade(customer);`, `var fee = total > 50m ? 0 : 4.99m;`].join("\n"),
      FILE,
      1,
    );
    expect(byKind(rules, "guard").map((r) => r.summary)).toEqual([
      "Branches on threshold points > 1000",
      "Branches on threshold total > 50m",
    ]);
  });

  it("mines an `is` pattern against an enum member", () => {
    const src = [
      `if (account is { State: AccountState.Frozen } || account.State is AccountState.Closed)`,
      `{`,
      `    Notify();`,
      `}`,
    ].join("\n");
    expect(byKind(mineCsRules(src, FILE, 1), "guard")).toHaveLength(1);
  });

  it("mines const and static readonly declarations", () => {
    const src = [
      `private const int MaxItemsPerOrder = 50;`,
      `public static readonly decimal VatRate = 0.2m;`,
      `internal const string DefaultCurrency = "EUR";`,
    ].join("\n");
    const c = byKind(mineCsRules(src, FILE, 1), "const");
    expect(c.map((r) => r.summary)).toEqual([
      "Constant `MaxItemsPerOrder` = 50",
      "Constant `VatRate` = 0.2m",
      'Constant `DefaultCurrency` = "EUR"',
    ]);
  });
});

describe("mineCsRules — false-positive guards", () => {
  it("does not mine a braced if whose body only logs, even with a threshold condition", () => {
    const src = [
      `if (retries > 3)`,
      `{`,
      `    _logger.LogWarning("Retried {Count} times", retries);`,
      `}`,
      `if (elapsed > 1000) {`,
      `    Console.WriteLine("slow");`,
      `    _logger.LogDebug("slow path");`,
      `}`,
    ].join("\n");
    expect(mineCsRules(src, FILE, 1)).toEqual([]);
  });

  it("does not mine an inline logging-only if or a log-level check", () => {
    const src = [
      `if (count > 0) _logger.LogInformation("Processed {Count}", count);`,
      `if (_logger.IsEnabled(LogLevel.Debug))`,
      `{`,
      `    var dump = Serialize(order);`,
      `}`,
      `if (options.MinimumLevel <= LogLevel.Debug)`,
      `{`,
      `    TraceRequest(request);`,
      `}`,
    ].join("\n");
    expect(mineCsRules(src, FILE, 1)).toEqual([]);
  });

  it("still mines a threshold if whose body logs AND acts", () => {
    const src = [
      `if (retries > 3)`,
      `{`,
      `    _logger.LogWarning("giving up");`,
      `    order.MarkFailed();`,
      `}`,
    ].join("\n");
    expect(byKind(mineCsRules(src, FILE, 1), "guard")).toHaveLength(1);
  });

  it("ignores comment lines", () => {
    expect(mineCsRules(`// if (x > 5) throw new Exception("no");`, FILE, 1)).toEqual([]);
  });
});

describe("mineCsRules — throws and guard helpers", () => {
  it("mines throw statements and throw expressions with their messages", () => {
    const src = [
      `throw new InvalidOperationException("Cannot ship a cancelled order");`,
      `var c = repo.Find(id) ?? throw new NotFoundException($"Customer {id} not found");`,
    ].join("\n");
    const t = byKind(mineCsRules(src, FILE, 1), "throw");
    expect(t.map((r) => r.summary)).toEqual([
      "Throws InvalidOperationException: Cannot ship a cancelled order",
      "Throws NotFoundException: Customer {id} not found",
    ]);
  });

  it("mines .NET ThrowIf helpers and Ardalis Guard.Against", () => {
    const src = [
      `ArgumentNullException.ThrowIfNull(order);`,
      `ArgumentOutOfRangeException.ThrowIfNegativeOrZero(quantity);`,
      `Guard.Against.NullOrEmpty(sku, nameof(sku));`,
    ].join("\n");
    const p = byKind(mineCsRules(src, FILE, 1), "precondition");
    expect(p.map((r) => r.summary)).toEqual([
      "ThrowIfNull guard on order (ArgumentNullException)",
      "ThrowIfNegativeOrZero guard on quantity (ArgumentOutOfRangeException)",
      "Guard against NullOrEmpty: sku, nameof(sku)",
    ]);
  });
});

describe("mineCsRules — validation attributes", () => {
  it("mines [Required], [Range] and [RegularExpression] on their own lines", () => {
    const src = [
      `public class OrderRequest`,
      `{`,
      `    [Required]`,
      `    public string CustomerId { get; set; }`,
      `    [Range(1, 100, ErrorMessage = "Quantity must be 1-100")]`,
      `    public int Quantity { get; set; }`,
      `    [RegularExpression(@"^[A-Z]{3}-\\d{4}$")]`,
      `    public string Sku { get; set; }`,
      `}`,
    ].join("\n");
    const a = byKind(mineCsRules(src, FILE, 1), "validation-attribute");
    expect(a.map((r) => r.summary)).toEqual([
      "Field is required",
      'Value must be within range 1, 100, ErrorMessage = "Quantity must be 1-100"',
      'Must match pattern @"^[A-Z]{3}-\\d{4}$"',
    ]);
    expect(a.map((r) => r.line)).toEqual([3, 5, 7]);
  });

  it("mines several attributes in one section and inline with the member", () => {
    const src = `[Required, StringLength(50, MinimumLength = 2)] public string Name { get; set; }`;
    const a = byKind(mineCsRules(src, FILE, 1), "validation-attribute");
    expect(a.map((r) => r.summary)).toEqual([
      "Field is required",
      "Length constraint StringLength(50, MinimumLength = 2)",
    ]);
  });

  it("accepts the Attribute suffix and a namespace qualifier; ignores non-validation attributes", () => {
    const src = [
      `[HttpPost("orders")]`,
      `[System.ComponentModel.DataAnnotations.RequiredAttribute]`,
      `[EmailAddress]`,
      `[Table("orders")]`,
    ].join("\n");
    const a = byKind(mineCsRules(src, FILE, 1), "validation-attribute");
    expect(a.map((r) => r.summary)).toEqual(["Field is required", "Must be a valid email address"]);
  });

  it('reads a verbatim string ending in a backslash as closed (no escape in @"...")', () => {
    // In C#, @"C:\" is the complete string `C:\` — the backslash does not escape
    // the closing quote. A regular-string scan would never close the section.
    const src = `[RegularExpression(@"^C:\\"), Required] public string Path { get; set; }`;
    const a = byKind(mineCsRules(src, FILE, 1), "validation-attribute");
    expect(a.map((r) => r.summary)).toEqual(['Must match pattern @"^C:\\"', "Field is required"]);
  });

  it("does not read array indexing as an attribute", () => {
    expect(
      byKind(mineCsRules(`var x = items[Required];`, FILE, 1), "validation-attribute"),
    ).toEqual([]);
  });
});

describe("mineCsRules — switch on status/enum", () => {
  it("mines a switch statement with qualified enum case labels", () => {
    const src = [
      `switch (order.Status)`,
      `{`,
      `    case OrderStatus.Pending:`,
      `        Confirm(order);`,
      `        break;`,
      `    case OrderStatus.Shipped:`,
      `    case OrderStatus.Delivered:`,
      `        throw new InvalidOperationException("Already dispatched");`,
      `    default:`,
      `        break;`,
      `}`,
    ].join("\n");
    const s = byKind(mineCsRules(src, FILE, 1), "switch-case");
    expect(s).toHaveLength(1);
    expect(s[0].summary).toBe(
      "State dispatch on `order.Status` with 3 branches: OrderStatus.Pending, OrderStatus.Shipped, OrderStatus.Delivered",
    );
  });

  it("strips a case guard (`when`) from the label", () => {
    const src = [
      `switch (order.Status) {`,
      `    case OrderStatus.Pending when order.IsRush:`,
      `        Expedite(order);`,
      `        break;`,
      `}`,
    ].join("\n");
    const s = byKind(mineCsRules(src, FILE, 1), "switch-case");
    expect(s.map((r) => r.summary)).toEqual([
      "State dispatch on `order.Status` with 1 branches: OrderStatus.Pending",
    ]);
  });

  it("does not collect case labels of a nested switch into the outer one", () => {
    const src = [
      `switch (a) {`,
      `  case Kind.One:`,
      `    switch (b) {`,
      `      case Sub.X: break;`,
      `    }`,
      `    break;`,
      `}`,
    ].join("\n");
    const s = byKind(mineCsRules(src, FILE, 1), "switch-case");
    expect(s.map((r) => r.summary)).toEqual([
      "State dispatch on `a` with 1 branches: Kind.One",
      "State dispatch on `b` with 1 branches: Sub.X",
    ]);
  });

  it("mines a switch expression", () => {
    const src = [
      `var discount = customer.Tier switch`,
      `{`,
      `    CustomerTier.Gold => 0.15m,`,
      `    CustomerTier.Silver => 0.05m,`,
      `    _ => 0m,`,
      `};`,
    ].join("\n");
    const s = byKind(mineCsRules(src, FILE, 1), "switch-case");
    expect(s.map((r) => r.summary)).toEqual([
      "State dispatch on `customer.Tier` with 2 branches: CustomerTier.Gold, CustomerTier.Silver",
    ]);
  });
});

describe("mineCsRules — FluentValidation", () => {
  it("mines a single-line rule chain", () => {
    const f = byKind(
      mineCsRules(`RuleFor(x => x.Email).NotEmpty().EmailAddress();`, FILE, 1),
      "fluent-rule",
    );
    expect(f.map((r) => r.summary)).toEqual(["Field `Email` rules: NotEmpty(), EmailAddress()"]);
  });

  it("mines a multi-line chain with arguments and message, once", () => {
    const src = [
      `RuleFor(o => o.Quantity)`,
      `    .GreaterThan(0)`,
      `    .LessThanOrEqualTo(MaxQuantity)`,
      `    .WithMessage("Quantity must be between 1 and the maximum");`,
      `RuleFor(o => o.Code).Must(c => c.StartsWith("A")).When(o => o.IsPriority);`,
    ].join("\n");
    const f = byKind(mineCsRules(src, FILE, 1), "fluent-rule");
    expect(f.map((r) => r.summary)).toEqual([
      'Field `Quantity` rules: GreaterThan(0), LessThanOrEqualTo(MaxQuantity) — "Quantity must be between 1 and the maximum"',
      'Field `Code` rules: Must(c => c.StartsWith("A"))',
    ]);
    expect(f.map((r) => r.line)).toEqual([1, 5]);
  });

  it("ignores a RuleFor with no recognised validators, leaving its lines to other passes", () => {
    expect(mineCsRules(`RuleFor(x => x.Name).Custom(Check);`, FILE, 1)).toEqual([]);
    const rules = mineCsRules(
      [
        `RuleFor(x => x.Name).Custom((name, ctx) =>`,
        `{`,
        `    if (name.Length > MaxName) ctx.AddFailure("too long");`,
        `});`,
      ].join("\n"),
      FILE,
      1,
    );
    expect(rules.map((r) => [r.kind, r.line])).toEqual([["guard", 3]]);
  });

  it("keeps a multi-line Must lambda inside its chain instead of mining it twice", () => {
    const src = [
      `RuleFor(o => o.Code).Must(c =>`,
      `{`,
      `    if (c.Length > MaxCodeLength) return false;`,
      `    return true;`,
      `});`,
      `RuleFor(o => o.Name).NotEmpty();`,
    ].join("\n");
    const rules = mineCsRules(src, FILE, 1);
    expect(rules.map((r) => [r.kind, r.line])).toEqual([
      ["fluent-rule", 1],
      ["fluent-rule", 6],
    ]);
    expect(rules[0].summary).toContain(
      "Field `Code` rules: Must(c => { if (c.Length > MaxCodeLength) return false;",
    );
  });
});

describe("renderMinedCsRules", () => {
  it("returns an empty string for no rules", () => {
    expect(renderMinedCsRules([])).toBe("");
  });

  it("groups by kind in a fixed order", () => {
    const rules = mineCsRules(
      [`private const int Max = 5;`, `[Required]`, `throw new Exception("boom");`].join("\n"),
      FILE,
      1,
    );
    const out = renderMinedCsRules(rules);
    expect(out.indexOf("Validation attributes")).toBeLessThan(out.indexOf("Throws"));
    expect(out.indexOf("Throws")).toBeLessThan(out.indexOf("Constants"));
    expect(out).toContain("- L2: Field is required");
  });

  it("truncates to the prompt budget", () => {
    const src = Array.from({ length: 50 }, (_, i) => `private const int Limit${i} = ${i};`).join(
      "\n",
    );
    const out = renderMinedCsRules(mineCsRules(src, FILE, 1), 200);
    expect(out).toContain("more C# rules truncated");
    expect(out.length).toBeLessThan(400);
  });
});

describe("mineCsRules — linear time on long lines (ReDoS)", () => {
  it("mines adversarial 5,000-character lines well inside a second", () => {
    // Each input defeated an earlier regex here — overlapping `\s*\{?\s*`, a lazy
    // `case` label with an optional guard, an unanchored identifier run before
    // `switch` — taking seconds per line and growing polynomially with length.
    const n = 5000;
    const inputs = [
      `if (a)${" ".repeat(n)}x`,
      `switch (a) {\ncase ${" ".repeat(n)}x`,
      `${"a".repeat(n)} switch`,
      `if (${"a) ".repeat(n / 3)}`,
      `RuleFor(x => x.A)${".Must(".repeat(n / 6)}`,
      `[Range(${" ".repeat(n)}`,
    ];
    const start = performance.now();
    for (const src of inputs) mineCsRules(src, FILE, 1);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("mines adversarial 80,000-character lines well inside a second (quadratic shapes)", () => {
    // Quadratic (not cubic) shapes need a longer line to show: two adjacent
    // optional whitespace runs after `if (...)`, and an unanchored identifier
    // run before `switch`, each cost seconds here before the fix.
    const n = 80_000;
    const inputs = [`if (a)${" ".repeat(n)}x`, "a".repeat(n)];
    const start = performance.now();
    for (const src of inputs) mineCsRules(src, FILE, 1);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
