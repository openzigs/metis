/**
 * Issue #161 — C / C++ rule miner. Synthetic fixtures only.
 */
import { describe, expect, it } from "vitest";
import { BODY_LOOKAHEAD } from "./rule-miner-brace-shared.js";
import { C_RULE_KINDS, mineCRules, renderMinedCRules } from "./c-rule-miner.js";

const FILE = "src/orders.c";

const C_SOURCE = `#include "orders.h"
#define MAX_ITEMS 50
#define CURRENCY "EUR"
#define SQUARE(x) ((x) * (x))
#define ORDER_H_INCLUDED

static const double SERVICE_FEE = 2.5;
const int kMaxRetries = 3;
static const char *const name = lookup();

enum order_status {
    ORDER_OPEN = 1,
    ORDER_HELD = 2,
    ORDER_CLOSED,
};

int place_order(struct order *o)
{
    assert(o != NULL);
    if (o->item_count > MAX_ITEMS)
        return -EINVAL;
    if (o->total <= 0) {
        fprintf(stderr, "bad total\\n");
        goto fail;
    }
    if (o->total > 10000) {
        printf("large order\\n");
    }
    double fee = o->total > FREE_SHIPPING ? 0.0 : SERVICE_FEE;
    switch (o->status) {
    case ORDER_OPEN:
        approve(o);
        break;
    case ORDER_HELD: case ORDER_REVIEW:
        hold(o);
        break;
    default:
        break;
    }
    return 0;
fail:
    return -1;
}
`;

const CPP_FILE = "src/pricing.cpp";
const CPP_SOURCE = `static_assert(sizeof(Money) == 16, "Money must stay 16 bytes");
constexpr double kVatRate = 0.2;

Money Pricing::price(const Order& order) const {
    Expects(!order.lines.empty());
    if (order.total() < Money{0}) {
        throw std::invalid_argument("negative total");
    }
    if (order.express() && order.weight() > MAX_EXPRESS_WEIGHT) throw ExpressError{"too heavy"};
    switch (order.status()) {
        case Status::Open: return quote(order);
        case Status::Closed: return Money{};
    }
    return order.total() > FREE_LIMIT ? order.total() : order.total() + fee_;
}
`;

const byKind = (src: string, kind: string, file = FILE) =>
  mineCRules(src, file, 1).filter((r) => r.kind === kind);

describe("mineCRules — C fixture", () => {
  it("mines literal #defines, const declarations and explicit enumerators", () => {
    expect(byKind(C_SOURCE, "const").map((r) => [r.line, r.summary])).toEqual([
      [2, "Constant `MAX_ITEMS` = 50"],
      [3, 'Constant `CURRENCY` = "EUR"'],
      [7, "Constant `SERVICE_FEE` = 2.5"],
      [8, "Constant `kMaxRetries` = 3"],
      [12, "Constant `ORDER_OPEN` = 1"],
      [13, "Constant `ORDER_HELD` = 2"],
    ]);
  });

  it("mines assert as a precondition", () => {
    expect(byKind(C_SOURCE, "precondition").map((r) => [r.line, r.summary])).toEqual([
      [19, "assert(o != NULL)"],
    ]);
  });

  it("mines return / goto guards and ternary thresholds, skipping a logging-only if", () => {
    expect(byKind(C_SOURCE, "guard").map((r) => [r.line, r.summary])).toEqual([
      [20, "Rejects/exits when o->item_count > MAX_ITEMS"],
      [22, "Rejects/exits when o->total <= 0"],
      [29, "Branches on threshold o->total > FREE_SHIPPING"],
    ]);
  });

  it("mines a switch as one dispatch rule, several labels per line, without default", () => {
    expect(byKind(C_SOURCE, "switch-branch").map((r) => [r.line, r.summary])).toEqual([
      [30, "State dispatch on `o->status` with 3 branches: ORDER_OPEN, ORDER_HELD, ORDER_REVIEW"],
    ]);
  });
});

describe("mineCRules — C++ fixture", () => {
  it("mines static_assert and Expects", () => {
    expect(byKind(CPP_SOURCE, "precondition", CPP_FILE).map((r) => r.summary)).toEqual([
      "static_assert(sizeof(Money) == 16): Money must stay 16 bytes",
      "Expects(!order.lines.empty())",
    ]);
  });

  it("mines throws with their messages and the guards around them", () => {
    expect(byKind(CPP_SOURCE, "throw", CPP_FILE).map((r) => [r.line, r.summary])).toEqual([
      [7, "Throws std::invalid_argument: negative total"],
      [9, "Throws ExpressError: too heavy"],
    ]);
    expect(byKind(CPP_SOURCE, "guard", CPP_FILE).map((r) => [r.line, r.summary])).toEqual([
      [6, "Rejects/exits when order.total() < Money{0}"],
      [9, "Rejects when order.express() && order.weight() > MAX_EXPRESS_WEIGHT"],
      [14, "Branches on threshold order.total() > FREE_LIMIT"],
    ]);
  });

  it("reads scoped enum labels past their `::`", () => {
    expect(byKind(CPP_SOURCE, "switch-branch", CPP_FILE).map((r) => r.summary)).toEqual([
      "State dispatch on `order.status()` with 2 branches: Status::Open, Status::Closed",
    ]);
  });

  it("mines constexpr constants", () => {
    expect(byKind(CPP_SOURCE, "const", CPP_FILE).map((r) => r.summary)).toEqual([
      "Constant `kVatRate` = 0.2",
    ]);
  });
});

describe("mineCRules — multi-line and edge forms (#170 shapes)", () => {
  it("mines an if whose condition spans lines, anchored at its first line", () => {
    const src = [
      "if (o->total > LIMIT &&",
      "    o->express)",
      "{",
      "    return ERR_LIMIT;",
      "}",
    ].join("\n");
    expect(mineCRules(src, FILE, 10)).toEqual([
      expect.objectContaining({
        kind: "guard",
        line: 10,
        summary: "Rejects/exits when o->total > LIMIT && o->express",
      }),
    ]);
  });

  it("mines an assert whose condition spans lines", () => {
    const src = ["assert(", "    qty > 0 &&", "    qty <= MAX_QTY);"].join("\n");
    expect(byKind(src, "precondition").map((r) => [r.line, r.summary])).toEqual([
      [1, "assert(qty > 0 && qty <= MAX_QTY)"],
    ]);
  });

  it("keeps a guard whose body logs before it exits, and reads parens inside char literals", () => {
    const src = [
      "if (c == '(' || c == ')') {",
      '    LOG_WARN("paren");',
      "    return PARSE_ERROR;",
      "}",
    ].join("\n");
    expect(byKind(src, "guard").map((r) => r.summary)).toEqual([
      "Rejects/exits when c == '(' || c == ')'",
    ]);
  });

  it("does not mine a macro function, include guard or a logging call as a rule", () => {
    const src = [
      "#define MIN(a, b) ((a) < (b) ? (a) : (b))",
      "#define GUARD_H",
      'printf("%d ? %d : x", a, b);',
    ].join("\n");
    expect(mineCRules(src, FILE, 1)).toEqual([]);
  });
});

describe("mineCRules — bounds", () => {
  it("honours maxRules", () => {
    const src = Array.from({ length: 30 }, (_, k) => `#define LIMIT_${k} ${k}`).join("\n");
    expect(mineCRules(src, FILE, 1)).toHaveLength(30);
    expect(mineCRules(src, FILE, 1, null, 4)).toHaveLength(4);
  });

  it("stays linear on adversarial long lines (ReDoS)", () => {
    const n = 20_000;
    const inputs = [
      `#define A${" ".repeat(n)}`,
      `#define ${"A".repeat(n)}(`,
      `static const ${"int ".repeat(n / 4)}x`,
      `A${" ".repeat(n)}= 1${" ".repeat(n)}x`,
      `assert(${"(".repeat(n)}`,
      `if (${"'".repeat(n)}`,
      `switch (a) {${" case A:".repeat(n / 8)}`,
      `x = a${" ?".repeat(n / 2)}`,
      `throw ${"a:".repeat(n / 2)}`,
      `LOG${"_".repeat(n)}x`,
      `if (a) b${" ".repeat(n)}c`,
    ];
    const start = performance.now();
    for (const src of inputs) mineCRules(src, FILE, 1);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  // Per physical line, the work is bounded by constants: the #170 joiner reads
  // at most MAX_CONTINUATION_LINES lines (proved in rule-miner-continuation.test.ts)
  // and every body / arm scan at most BODY_LOOKAHEAD lines (proved here), so a
  // file is mined in linear time. Counting, not timing, so it cannot flake
  // under load (#1379).
  it("reads a dispatch block's arms no further than BODY_LOOKAHEAD lines (linear bound)", () => {
    const filler = Array.from({ length: BODY_LOOKAHEAD + 20 }, () => "  work()");
    const early = ["switch (x) {", "    case EARLY:", ...filler, "    case LATE:", "}"].join("\n");
    const labels = mineCRules(early, FILE, 1).find((r) => r.kind === "switch-branch")!.summary;
    expect(labels).toMatch(/Early|EARLY/);
    expect(labels).not.toMatch(/Late|LATE/);
  });
});

describe("renderMinedCRules", () => {
  it("renders every kind the miner produces", () => {
    const rules = [...mineCRules(C_SOURCE, FILE, 1), ...mineCRules(CPP_SOURCE, CPP_FILE, 1)];
    for (const kind of C_RULE_KINDS) expect(rules.some((r) => r.kind === kind)).toBe(true);
    const out = renderMinedCRules(rules, 100_000);
    expect(out.match(/^- L\d+:/gm)).toHaveLength(rules.length);
    expect(out).toContain("### State machines (switch/case) (2)");
    expect(renderMinedCRules(rules, 40)).toContain("more C/C++ rules truncated");
  });
});
