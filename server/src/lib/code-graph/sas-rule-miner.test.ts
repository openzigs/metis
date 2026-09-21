/**
 * Unit tests for the SAS rule miner (#271, item 3).
 *
 * These prove the deterministic miner surfaces the categories of SAS
 * business logic the LLM tends to gloss over: subsetting IF row filters,
 * WHERE filters, IF/THEN/ELSE branch logic, RETAIN carried state, KEEP/DROP
 * field selection, PROC options / SQL clauses, and macro parameter contracts.
 */
import { describe, expect, it } from "vitest";
import {
  mineSasRules,
  renderMinedSasRules,
  mineSasWorkflow,
  renderSasWorkflow,
  renderSasDataLineage,
  type MinedSasRule,
} from "./sas-rule-miner.js";

const FILE = "sas/etl/risk_calc.sas";

function kinds(rules: MinedSasRule[]): Set<string> {
  return new Set(rules.map((r) => r.kind));
}
function byKind(rules: MinedSasRule[], k: MinedSasRule["kind"]): MinedSasRule[] {
  return rules.filter((r) => r.kind === k);
}

describe("mineSasRules", () => {
  it("classifies a subsetting IF (no THEN) as a row filter", () => {
    const rules = mineSasRules(`if status = 'A';`, FILE, 1, "load::clean");
    const f = byKind(rules, "subsetting-if");
    expect(f).toHaveLength(1);
    expect(f[0].summary).toMatch(/Keep observation only when/);
    expect(f[0].summary).toContain("status = 'A'");
    expect(f[0].line).toBe(1);
    expect(f[0].context).toBe("load::clean");
  });

  it("classifies IF/THEN and ELSE as conditional branch logic (NOT a subsetting filter)", () => {
    const src = [`if amount > 1000 then tier = 'GOLD';`, `else tier = 'STD';`].join("\n");
    const rules = mineSasRules(src, FILE, 10);
    const cond = byKind(rules, "conditional");
    expect(cond.length).toBe(2);
    expect(cond[0].summary).toMatch(/When amount > 1000 then/);
    expect(cond[1].summary).toMatch(/Otherwise/);
    // An IF/THEN must NOT be misclassified as a pure subsetting filter.
    expect(byKind(rules, "subsetting-if")).toHaveLength(0);
    expect(cond[0].line).toBe(10);
    expect(cond[1].line).toBe(11);
  });

  it("classifies ELSE IF as conditional, not subsetting", () => {
    const rules = mineSasRules(`else if region = 'EU' then vat = 0.2;`, FILE, 1);
    expect(byKind(rules, "conditional")).toHaveLength(1);
    expect(byKind(rules, "subsetting-if")).toHaveLength(0);
  });

  it("captures WHERE filters", () => {
    const rules = mineSasRules(`where year >= 2020 and active = 1;`, FILE, 3);
    const w = byKind(rules, "where-filter");
    expect(w).toHaveLength(1);
    expect(w[0].summary).toMatch(/Select rows where/);
    expect(w[0].summary).toContain("year >= 2020");
  });

  it("captures RETAIN carried state", () => {
    const rules = mineSasRules(`retain running_total 0 last_id;`, FILE, 5);
    const r = byKind(rules, "retain");
    expect(r).toHaveLength(1);
    expect(r[0].summary).toMatch(/Retains across rows/);
    expect(r[0].summary).toContain("running_total");
  });

  it("captures KEEP and DROP output-field selection", () => {
    const rules = mineSasRules(`keep id name status;\ndrop tmp_flag;`, FILE, 1);
    const kd = byKind(rules, "keep-drop");
    expect(kd).toHaveLength(2);
    expect(kd[0].summary).toMatch(/Output keeps fields/);
    expect(kd[1].summary).toMatch(/Output drops fields/);
  });

  it("captures macro parameter contracts", () => {
    const rules = mineSasRules(`%macro score(input=, threshold=0.5);`, FILE, 1);
    const mp = byKind(rules, "macro-param");
    expect(mp).toHaveLength(1);
    expect(mp[0].summary).toContain("score");
    expect(mp[0].summary).toContain("threshold=0.5");
  });

  it("captures a macro with no parameters", () => {
    const rules = mineSasRules(`%macro run_all;`, FILE, 1);
    const mp = byKind(rules, "macro-param");
    expect(mp).toHaveLength(1);
    expect(mp[0].summary).toMatch(/no parameters/);
  });

  it("captures PROC options: BY, CLASS, VAR, TABLES, MODEL", () => {
    const src = [
      `by region descending sales;`,
      `class product;`,
      `var revenue cost;`,
      `tables status*outcome;`,
      `model y = x1 x2;`,
    ].join("\n");
    const rules = mineSasRules(src, FILE, 1);
    const opts = byKind(rules, "proc-option");
    expect(opts.length).toBe(5);
    const labels = opts.map((o) => o.summary.split(":")[0]);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Group/sort BY",
        "Classification CLASS",
        "Analysis VAR",
        "Frequency TABLES",
        "MODEL specification",
      ]),
    );
  });

  it("captures PROC SQL clauses: GROUP BY, HAVING, ORDER BY, join ON", () => {
    const src = [
      `select region, sum(sales) as total`,
      `from sales_db`,
      `group by region`,
      `having sum(sales) > 1000`,
      `order by total desc;`,
    ].join("\n");
    const rules = mineSasRules(src, FILE, 1);
    const opts = byKind(rules, "proc-option").map((o) => o.summary.split(":")[0]);
    expect(opts).toEqual(
      expect.arrayContaining(["SQL GROUP BY", "SQL HAVING filter", "SQL ORDER BY"]),
    );
  });

  it("reports accurate line numbers offset from baseLine", () => {
    const rules = mineSasRules(`x = 1;\nif keep_it;`, FILE, 100);
    const f = byKind(rules, "subsetting-if");
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(101);
  });

  it("ignores plain assignments and blank lines", () => {
    const rules = mineSasRules(`\n  total = a + b;\n  /* comment */\n`, FILE, 1);
    expect(rules).toHaveLength(0);
  });

  it("truncates a runaway expression to keep the prompt budget bounded", () => {
    const long = `if ${"a = 1 and ".repeat(80)} x = 1;`;
    const rules = mineSasRules(long, FILE, 1);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0].expression.length).toBeLessThanOrEqual(200);
  });

  it("handles a realistic risk-calc-style slice end to end", () => {
    const src = [
      `%macro risk_calc(asof=, cutoff=0.8);`,
      `data flagged;`,
      `  set raw.exposures;`,
      `  where reporting_date <= &asof;`,
      `  retain cum_exposure 0;`,
      `  cum_exposure = cum_exposure + amount;`,
      `  if rating in ('CCC','D') then risk_flag = 1;`,
      `  else risk_flag = 0;`,
      `  if amount > 0;`,
      `  keep entity_id amount risk_flag cum_exposure;`,
      `run;`,
      `%mend;`,
    ].join("\n");
    const rules = mineSasRules(src, FILE, 1, "risk_calc.sas::flagged");
    const ks = kinds(rules);
    expect(ks).toContain("macro-param");
    expect(ks).toContain("where-filter");
    expect(ks).toContain("retain");
    expect(ks).toContain("conditional");
    expect(ks).toContain("subsetting-if");
    expect(ks).toContain("keep-drop");
  });
});

describe("renderMinedSasRules", () => {
  it("returns empty string for no rules", () => {
    expect(renderMinedSasRules([])).toBe("");
  });

  it("groups rules under labelled headings", () => {
    const rules = mineSasRules(`if x;\nwhere y;\nretain z;\nkeep a;\n%macro m(p=);`, FILE, 1);
    const out = renderMinedSasRules(rules);
    expect(out).toContain("Subsetting IF (row filters)");
    expect(out).toContain("WHERE filters");
    expect(out).toContain("RETAIN (carried state)");
    expect(out).toContain("KEEP/DROP (output fields)");
    expect(out).toContain("Macro parameters");
  });

  it("labels every rule kind (conditional, retain, proc-option)", () => {
    const rules = mineSasRules(`if a then b;\nretain r;\nby region;`, FILE, 1);
    const out = renderMinedSasRules(rules);
    expect(out).toContain("Conditional logic (IF/THEN/ELSE)");
    expect(out).toContain("RETAIN (carried state)");
    expect(out).toContain("PROC options / SQL clauses");
  });

  it("honours the maxChars budget", () => {
    const many = Array.from({ length: 200 }, (_, i) => `if col${i} > 0;`).join("\n");
    const rules = mineSasRules(many, FILE, 1);
    const out = renderMinedSasRules(rules, 500);
    expect(out.length).toBeLessThan(700);
    expect(out).toMatch(/truncated for prompt budget/);
  });
});

describe("mineSasWorkflow", () => {
  it("captures a DATA step's reads (SET), writes (output name), and ordered actions", () => {
    const src = [
      `data flagged;`,
      `  set raw.exposures;`,
      `  where reporting_date <= 20240101;`,
      `  retain cum_exposure 0;`,
      `  if rating in ('CCC','D') then risk_flag = 1;`,
      `  if amount > 0;`,
      `  output;`,
      `run;`,
    ].join("\n");
    const { steps } = mineSasWorkflow(src, FILE, 1);
    expect(steps).toHaveLength(1);
    const step = steps[0];
    expect(step.kind).toBe("data");
    expect(step.name).toBe("DATA flagged");
    expect(step.line).toBe(1);
    expect(step.reads).toContain("raw.exposures");
    expect(step.writes).toContain("flagged");
    // Ordered actions reflect the real step behaviour.
    expect(step.actions.some((a) => /Reads raw\.exposures/.test(a))).toBe(true);
    expect(step.actions.some((a) => /Filters rows where/.test(a))).toBe(true);
    expect(step.actions.some((a) => /Retains across rows/.test(a))).toBe(true);
    expect(step.actions.some((a) => /If rating/.test(a))).toBe(true);
    expect(step.actions.some((a) => /Keeps rows where amount > 0/.test(a))).toBe(true);
    expect(step.actions.some((a) => /Writes (row to|the current row)/.test(a))).toBe(true);
  });

  it("captures a PROC step's data= input and out= output as lineage", () => {
    const src = [`proc sort data=work.input out=work.sorted;`, `  by id;`, `run;`].join("\n");
    const { steps } = mineSasWorkflow(src, FILE, 1);
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("proc");
    expect(steps[0].name).toBe("PROC sort");
    expect(steps[0].reads).toContain("work.input");
    expect(steps[0].writes).toContain("work.sorted");
  });

  it("captures PROC SQL create-table-as-from lineage", () => {
    const src = [
      `proc sql;`,
      `  create table summary as`,
      `  select region, sum(sales) as total`,
      `  from sales_db`,
      `  group by region;`,
      `quit;`,
    ].join("\n");
    const { steps } = mineSasWorkflow(src, FILE, 1);
    expect(steps).toHaveLength(1);
    expect(steps[0].writes).toContain("summary");
    expect(steps[0].reads).toContain("sales_db");
  });

  it("orders multiple steps and chains a pipeline (read -> intermediate -> final)", () => {
    const src = [
      `data stg;`,
      `  set raw.src;`,
      `run;`,
      `data final;`,
      `  set stg;`,
      `  keep id total;`,
      `run;`,
    ].join("\n");
    const { steps } = mineSasWorkflow(src, FILE, 1);
    expect(steps.map((s) => s.name)).toEqual(["DATA stg", "DATA final"]);
    expect(steps[0].reads).toContain("raw.src");
    expect(steps[0].writes).toContain("stg");
    // The second step reads the first step's output — a real cross-step pipeline.
    expect(steps[1].reads).toContain("stg");
    expect(steps[1].writes).toContain("final");
  });

  it("captures a MERGE as a multi-dataset read", () => {
    const src = [`data joined;`, `  merge a b;`, `  by id;`, `run;`].join("\n");
    const { steps } = mineSasWorkflow(src, FILE, 1);
    expect(steps[0].reads).toEqual(expect.arrayContaining(["a", "b"]));
    expect(steps[0].actions.some((act) => /Merges a, b/.test(act))).toBe(true);
  });

  it("reports accurate line numbers offset from baseLine", () => {
    const src = [`data d;`, `  set s;`, `run;`].join("\n");
    const { steps } = mineSasWorkflow(src, FILE, 100);
    expect(steps[0].line).toBe(100);
  });

  it("ignores steps with no lineage and no actions (e.g. an empty PROC print)", () => {
    const src = [`proc print;`, `run;`].join("\n");
    const { steps } = mineSasWorkflow(src, FILE, 1);
    expect(steps).toHaveLength(0);
  });

  it("does not treat a `data=` option as a DATA step opener", () => {
    // A stray `data=foo` inside a PROC must not open a spurious DATA step.
    const src = [`proc means data=metrics;`, `  var revenue;`, `run;`].join("\n");
    const { steps } = mineSasWorkflow(src, FILE, 1);
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("proc");
    expect(steps[0].reads).toContain("metrics");
  });

  it("handles a realistic risk-calc-style slice end to end (workflow + lineage)", () => {
    const src = [
      `%macro risk_calc(asof=, cutoff=0.8);`,
      `data flagged;`,
      `  set raw.exposures;`,
      `  where reporting_date <= &asof;`,
      `  retain cum_exposure 0;`,
      `  cum_exposure = cum_exposure + amount;`,
      `  if rating in ('CCC','D') then risk_flag = 1;`,
      `  else risk_flag = 0;`,
      `  if amount > 0;`,
      `  keep entity_id amount risk_flag cum_exposure;`,
      `run;`,
      `proc summary data=flagged;`,
      `  class entity_id;`,
      `  output out=rollup;`,
      `run;`,
      `%mend;`,
    ].join("\n");
    const { steps } = mineSasWorkflow(src, FILE, 1);
    expect(steps).toHaveLength(2);
    expect(steps[0].reads).toContain("raw.exposures");
    expect(steps[0].writes).toContain("flagged");
    expect(steps[1].reads).toContain("flagged");
    expect(steps[1].writes).toContain("rollup");
  });
});

describe("renderSasWorkflow / renderSasDataLineage", () => {
  const WF = mineSasWorkflow(
    [`data out;`, `  set src;`, `  if x > 0;`, `run;`].join("\n"),
    FILE,
    1,
  );

  it("renders an empty string when there are no steps", () => {
    expect(renderSasWorkflow({ steps: [] })).toBe("");
    expect(renderSasDataLineage({ steps: [] })).toBe("");
  });

  it("renders a numbered step pipeline with reads/writes and actions", () => {
    const out = renderSasWorkflow(WF);
    expect(out).toContain("1. **DATA out**");
    expect(out).toContain("reads src");
    expect(out).toContain("writes out");
    expect(out).toContain("Keeps rows where x > 0");
  });

  it("renders per-step dataset lineage as reads -> writes lines", () => {
    const out = renderSasDataLineage(WF);
    expect(out).toContain("DATA out: reads [src] → writes [out]");
  });

  it("honours the maxChars budget for the workflow render", () => {
    const many = Array.from({ length: 100 }, (_, i) => `data d${i};\n  set s${i};\nrun;`).join(
      "\n",
    );
    const wf = mineSasWorkflow(many, FILE, 1);
    const out = renderSasWorkflow(wf, 300);
    expect(out.length).toBeLessThan(500);
    expect(out).toMatch(/truncated for prompt budget/);
  });
});
