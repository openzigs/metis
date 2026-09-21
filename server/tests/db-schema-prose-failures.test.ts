/**
 * Issue #1228 — DB schema prose: count what landed, never what was attempted.
 *
 * The shipped synthesizer claimed prose descriptions for 510 of 641 tables when
 * ZERO were produced, marked the document `ready` with `warnings = NULL`, and
 * burned ~17 LLM calls doing it. Three defects combined:
 *
 *   1. `proseTableCount += batch.length` ran BEFORE `provider.chat()`, so the
 *      banner reported attempts as successes.
 *   2. The `if (jsonMatch)` had no `else` — a response that failed the regex
 *      vanished without a log line, a warning, or a status change.
 *   3. `provider.chat()` passed no `maxTokens`, so it inherited the provider's
 *      4096 default; a 30-table JSON batch was cut mid-object, the brace never
 *      closed, and (2) swallowed it.
 *
 * Every assertion below is on an observable the shipped code got WRONG: the
 * `maxTokens` argument actually handed to `provider.chat`, the warnings the
 * synthesizer returns, and the banner text — which must be derived from the same
 * description set the table sections and the schema graph render from, so it is
 * structurally incapable of disagreeing with them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatOptions, ChatResponse } from "../src/lib/ai/types.js";
import type { DbTableInfo, SchemaGraph } from "@metis/shared";

// ---------------------------------------------------------------------------
// Provider stub — records every `chat` call's OPTIONS, which is the only place
// a missing `maxTokens` is observable. The stub deliberately has NO output cap
// of its own: asserting on downstream behaviour would pass with the argument
// removed (#1224), so the argument itself is what these tests pin.
// ---------------------------------------------------------------------------
const { chatSpy, providerState, buildProviderSpy } = vi.hoisted(() => ({
  chatSpy: vi.fn(),
  buildProviderSpy: vi.fn(),
  providerState: {
    model: "us.anthropic.claude-sonnet-4-6-v1:0" as string | undefined,
    buildThrows: false,
  },
}));

vi.mock("../src/lib/ai/index.js", () => ({
  loadAIConfig: vi.fn(() => ({})),
  buildProvider: (...args: unknown[]) => {
    buildProviderSpy(...args);
    if (providerState.buildThrows) throw new Error("no AI provider configured");
    return {
      key: "bedrock",
      model: providerState.model,
      offline: false,
      chat: chatSpy,
    };
  },
}));

const { mockInspect, mockGetConnector } = vi.hoisted(() => ({
  mockInspect: vi.fn(),
  mockGetConnector: vi.fn(),
}));

vi.mock("../src/lib/connectors/db/db-service.js", () => ({
  inspectDbConnector: mockInspect,
  getDbConnector: mockGetConnector,
}));

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));

vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: logWarn, error: vi.fn(), debug: vi.fn() }),
}));

// The used-objects section is out of scope here; keep it out of the markdown.
vi.mock("../src/lib/impact-analysis/used-schema-classifier.js", () => ({
  readUsageClassification: vi.fn(async () => []),
}));

import {
  synthesizeDbSchemaDocument,
  parseTableDescriptions,
  buildTableKeyIndex,
  resolveTableKey,
} from "../src/lib/docs-gen/db-schema-synthesizer.js";
import {
  DEFAULT_DB_SCHEMA_PROSE_MAX_OUTPUT_TOKENS,
  modelOutputCeiling,
} from "../src/lib/docs-gen/output-caps.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTable(name: string): DbTableInfo {
  return {
    schema: "ORDERBATCH",
    name,
    columns: [
      { name: "ID", dataType: "NUMBER", isPrimaryKey: true, isForeignKey: false, nullable: false },
      {
        name: "PAYLOAD",
        dataType: "VARCHAR2(4000)",
        isPrimaryKey: false,
        isForeignKey: false,
        nullable: true,
      },
    ],
    foreignKeys: [],
  } as unknown as DbTableInfo;
}

function tables(count: number): DbTableInfo[] {
  return Array.from({ length: count }, (_, i) => makeTable(`SALESDB_TABLE_${i + 1}`));
}

/** A well-formed provider response describing every table it is given. */
function describeAll(list: DbTableInfo[], finishReason = "stop"): ChatResponse {
  const descriptions: Record<string, string> = {};
  for (const t of list) descriptions[t.name] = `Stores rows for ${t.name}.`;
  return {
    content: JSON.stringify({ descriptions }),
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    model: "stub",
    provider: "bedrock",
    finishReason,
  } as unknown as ChatResponse;
}

function response(content: string, finishReason?: string): ChatResponse {
  return {
    content,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    model: "stub",
    provider: "bedrock",
    ...(finishReason ? { finishReason } : {}),
  } as unknown as ChatResponse;
}

async function synthesize(list: DbTableInfo[]) {
  mockInspect.mockResolvedValue({ tables: list });
  mockGetConnector.mockResolvedValue({ label: "ORDERBATCH-SALESDB" });
  return synthesizeDbSchemaDocument("p1", "conn1", "actor1", "Database Schema");
}

/** Count schema-graph nodes that carry a non-empty description. */
function graphDescribed(graph: SchemaGraph | null): number {
  return (graph?.tables ?? []).filter((t) => t.description.trim() !== "").length;
}

/** Count `### <table>` sections that carry prose before their column table. */
function sectionsWithProse(markdown: string): number {
  const body = markdown.slice(markdown.indexOf("## Table Reference"));
  return body
    .split(/^### /m)
    .slice(1)
    .filter((section) => {
      const afterHeading = section.slice(section.indexOf("\n") + 1);
      const beforeTable = afterHeading.slice(0, afterHeading.indexOf("| Column |"));
      return beforeTable.trim().length > 0;
    }).length;
}

beforeEach(() => {
  chatSpy.mockReset();
  logWarn.mockReset();
  buildProviderSpy.mockReset();
  mockInspect.mockReset();
  mockGetConnector.mockReset();
  providerState.model = "us.anthropic.claude-sonnet-4-6-v1:0";
  providerState.buildThrows = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DOCS_GEN_DB_SCHEMA_MAX_OUTPUT_TOKENS;
});

// ---------------------------------------------------------------------------
// Defect 3 — the call inherited the provider's 4096 default
// ---------------------------------------------------------------------------

describe("#1228 defect 3 — an explicit output cap is passed to provider.chat", () => {
  it("passes an explicit maxTokens instead of inheriting the provider default", async () => {
    chatSpy.mockImplementation(async (_m: unknown, _o?: ChatOptions) => describeAll(tables(3)));
    await synthesize(tables(3));

    expect(chatSpy).toHaveBeenCalledTimes(1);
    const opts = chatSpy.mock.calls[0]?.[1] as ChatOptions | undefined;
    // The shipped code called `provider.chat(messages)` with no options at all.
    expect(opts?.maxTokens).toBeTypeOf("number");
    expect(opts?.maxTokens).toBeGreaterThan(4096);
  });

  it("sizes the cap for the model the call actually runs, not the module default", async () => {
    // A provider instance is frequently shared across models; the clamp has to
    // use the model on the instance this call goes through.
    providerState.model = "us.anthropic.claude-3-5-haiku-20241022-v1:0";
    chatSpy.mockImplementation(async () => describeAll(tables(2)));
    await synthesize(tables(2));

    const opts = chatSpy.mock.calls[0]?.[1] as ChatOptions | undefined;
    expect(opts?.maxTokens).toBe(modelOutputCeiling(providerState.model));
    expect(opts?.maxTokens).toBeLessThan(DEFAULT_DB_SCHEMA_PROSE_MAX_OUTPUT_TOKENS);
  });

  it("never asks a known model for more than its documented output ceiling", async () => {
    for (const model of [
      "us.anthropic.claude-3-5-haiku-20241022-v1:0",
      "anthropic.claude-3-sonnet-20240229-v1:0",
      "us.anthropic.claude-sonnet-4-6-v1:0",
    ]) {
      chatSpy.mockReset();
      providerState.model = model;
      chatSpy.mockImplementation(async () => describeAll(tables(2)));
      await synthesize(tables(2));
      const opts = chatSpy.mock.calls[0]?.[1] as ChatOptions | undefined;
      expect(opts?.maxTokens).toBeLessThanOrEqual(modelOutputCeiling(model) as number);
    }
  });

  it("keeps the pre-#1228 safe value for a model with no known ceiling", async () => {
    providerState.model = "some-local-gemma-27b";
    chatSpy.mockImplementation(async () => describeAll(tables(2)));
    await synthesize(tables(2));

    const opts = chatSpy.mock.calls[0]?.[1] as ChatOptions | undefined;
    expect(opts?.maxTokens).toBe(8192);
  });
});

// ---------------------------------------------------------------------------
// The tolerant extractor (AC #4)
// ---------------------------------------------------------------------------

describe("#1228 parseTableDescriptions", () => {
  it("parses a bare JSON object", () => {
    const r = parseTableDescriptions('{"descriptions":{"A":"one","B":"two"}}');
    expect(r.ok).toBe(true);
    expect(r.descriptions).toEqual({ A: "one", B: "two" });
  });

  it("parses a fenced JSON body with prose around it", () => {
    const r = parseTableDescriptions(
      'Sure! Here you go:\n```json\n{\n "descriptions": {"A": "one"}\n}\n```\nHope that helps.',
    );
    expect(r.ok).toBe(true);
    expect(r.descriptions).toEqual({ A: "one" });
  });

  it("reports an unterminated object rather than silently returning nothing", () => {
    // Exactly the shape a max_tokens cut produces: the value strings hold no
    // braces of their own, so a truncated body has NO closing brace at all.
    const r = parseTableDescriptions('{"descriptions":{"A":"one","B":"two');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unterminated-json");
  });

  it("reports an empty body", () => {
    expect(parseTableDescriptions("   ").reason).toBe("empty-response");
  });

  it("reports a body with no JSON object at all", () => {
    expect(parseTableDescriptions("I cannot help with that request.").reason).toBe(
      "no-json-object",
    );
  });

  it("reports a malformed object", () => {
    expect(parseTableDescriptions('{"descriptions": {"A": one}}').reason).toBe("invalid-json");
  });

  it("reports a JSON object that carries no descriptions", () => {
    expect(parseTableDescriptions('{"descriptions": "not an object"}').reason).toBe(
      "no-descriptions-field",
    );
  });

  it("accepts a flat name→description map without the wrapper key", () => {
    const r = parseTableDescriptions('{"A":"one","B":"two"}');
    expect(r.ok).toBe(true);
    expect(r.descriptions).toEqual({ A: "one", B: "two" });
  });

  it("survives braces and escaped quotes inside a description", () => {
    const r = parseTableDescriptions(
      '{"descriptions":{"A":"Holds the \\"raw\\" payload, e.g. {\\"k\\": 1}.","B":"Second."}}',
    );
    expect(r.ok).toBe(true);
    expect(Object.keys(r.descriptions)).toEqual(["A", "B"]);
  });

  it("rejects a JSON array", () => {
    expect(parseTableDescriptions('["A","B"]').ok).toBe(false);
  });

  it("drops a whitespace-only description", () => {
    const r = parseTableDescriptions('{"descriptions":{"A":"   ","B":"real"}}');
    expect(r.descriptions).toEqual({ B: "real" });
  });

  it("drops non-string values instead of stringifying them into the document", () => {
    const r = parseTableDescriptions('{"descriptions":{"A":"one","B":null,"C":{"x":1}}}');
    expect(r.descriptions).toEqual({ A: "one" });
  });
});

// ---------------------------------------------------------------------------
// Defects 1 + 2 — count what landed, and never drop a failure silently
// ---------------------------------------------------------------------------

describe("#1228 defects 1+2 — failures are counted and reported", () => {
  it("a truncated batch describes nothing, claims nothing, and degrades the document", async () => {
    const list = tables(3);
    chatSpy.mockImplementation(async () =>
      response('{"descriptions":{"SALESDB_TABLE_1":"Sto', "length"),
    );
    const result = await synthesize(list);

    expect(graphDescribed(result.schemaGraph)).toBe(0);
    expect(sectionsWithProse(result.markdown)).toBe(0);
    expect(result.markdown).toContain("0 of 3 tables");
    expect(result.markdown).not.toContain("3 of 3 tables");

    const kinds = result.warnings.map((w) => w.kind);
    expect(kinds).toContain("section-truncated");
    expect(result.warnings.every((w) => w.message.length > 0)).toBe(true);
  });

  it("names the DB-schema cap key in the truncation remedy, not the section key", async () => {
    chatSpy.mockImplementation(async () => response('{"descriptions":{"A":"x', "length"));
    const result = await synthesize(tables(2));
    const truncated = result.warnings.find((w) => w.kind === "section-truncated");
    expect(truncated?.message).toContain("DOCS_GEN_DB_SCHEMA_MAX_OUTPUT_TOKENS");
    expect(truncated?.message).not.toContain("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS");
  });

  it("a parseable-looking body that yields no descriptions is reported, not swallowed", async () => {
    // The shipped `if (jsonMatch)` had no else: this response produced NO log
    // line, NO warning and NO status change.
    chatSpy.mockImplementation(async () => response("I was unable to produce descriptions."));
    const result = await synthesize(tables(2));

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.map((w) => w.kind)).toContain("section-failed");
    expect(result.markdown).toContain("0 of 2 tables");
  });

  it("an empty response body is recorded as such", async () => {
    chatSpy.mockImplementation(async () => response(""));
    const result = await synthesize(tables(2));

    expect(result.warnings.map((w) => w.kind)).toContain("section-failed");
    expect(result.warnings[0]?.message).toContain("empty-response");
  });

  it("a throwing provider degrades the document instead of reporting ready", async () => {
    chatSpy.mockRejectedValue(new Error("gateway 500"));
    const result = await synthesize(tables(2));

    expect(result.warnings.map((w) => w.kind)).toContain("section-failed");
    expect(sectionsWithProse(result.markdown)).toBe(0);
    expect(result.markdown).toContain("0 of 2 tables");
  });

  it("descriptions for tables that are not in the schema are not counted as landed", async () => {
    chatSpy.mockImplementation(async () =>
      response('{"descriptions":{"SOME_OTHER_TABLE":"Invented by the model."}}'),
    );
    const result = await synthesize(tables(2));

    expect(graphDescribed(result.schemaGraph)).toBe(0);
    expect(result.markdown).not.toContain("Invented by the model.");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("a clean run produces prose, no warnings, and no shortfall banner", async () => {
    const list = tables(4);
    chatSpy.mockImplementation(async () => describeAll(list));
    const result = await synthesize(list);

    expect(graphDescribed(result.schemaGraph)).toBe(4);
    expect(sectionsWithProse(result.markdown)).toBe(4);
    expect(result.warnings).toEqual([]);
    expect(result.markdown).not.toContain("of 4 tables");
  });
});

// ---------------------------------------------------------------------------
// AC #6 — the banner is derived from the same set the sections render from
// ---------------------------------------------------------------------------

describe("#1228 AC6 — the banner cannot disagree with the document", () => {
  it("reports exactly the number of sections and graph nodes that carry prose", async () => {
    const list = tables(5);
    // The model answers for 2 of the 5 tables it was asked about.
    chatSpy.mockImplementation(async () =>
      response(
        JSON.stringify({
          descriptions: {
            SALESDB_TABLE_1: "Holds submitted jobs.",
            SALESDB_TABLE_4: "Holds invoice rows.",
          },
        }),
      ),
    );
    const result = await synthesize(list);

    const described = graphDescribed(result.schemaGraph);
    expect(described).toBe(2);
    expect(sectionsWithProse(result.markdown)).toBe(described);
    expect(result.markdown).toContain(`${described} of 5 tables`);
  });

  it("still reports the honest count when the call budget stops the run early", async () => {
    process.env.DB_SCHEMA_SYNTH_LLM_CALL_BUDGET = "1";
    process.env.DB_SCHEMA_SYNTH_BATCH_SIZE = "2";
    try {
      const list = tables(6);
      chatSpy.mockImplementation(async (messages: unknown) => {
        const prompt = (messages as Array<{ content: string }>)[0]?.content ?? "";
        const named = list.filter((t) => prompt.includes(`Table: ${t.name}`));
        return describeAll(named);
      });
      const result = await synthesize(list);

      expect(chatSpy).toHaveBeenCalledTimes(1);
      const described = graphDescribed(result.schemaGraph);
      expect(described).toBe(2);
      expect(sectionsWithProse(result.markdown)).toBe(described);
      expect(result.markdown).toContain("2 of 6 tables");
      expect(result.markdown).toContain("generation budget");
      // A budget stop is DESIGNED behaviour, not a degradation.
      expect(result.warnings).toEqual([]);
    } finally {
      delete process.env.DB_SCHEMA_SYNTH_LLM_CALL_BUDGET;
      delete process.env.DB_SCHEMA_SYNTH_BATCH_SIZE;
    }
  });

  it("claims nothing at all when no provider could be built", async () => {
    providerState.buildThrows = true;
    const result = await synthesize(tables(3));

    expect(chatSpy).not.toHaveBeenCalled();
    expect(graphDescribed(result.schemaGraph)).toBe(0);
    expect(result.markdown).not.toContain("prose descriptions");
  });

  it("degrades rather than shipping ready when no provider could be built", async () => {
    // A misconfigured provider produces a document with ZERO descriptions. That
    // is the exact `ready` / `warnings = NULL` outcome this issue exists to stop,
    // so it cannot be treated as a graceful skip.
    providerState.buildThrows = true;
    const result = await synthesize(tables(3));

    expect(result.warnings.map((w) => w.kind)).toContain("section-failed");
    expect(result.warnings[0]?.message).toContain("provider-unavailable");
    expect(result.warnings[0]?.message).toContain("0 of 3 tables");
  });
});

// ---------------------------------------------------------------------------
// The other way a batch can land zero: names that match no table
// ---------------------------------------------------------------------------

describe("#1228 — a model's table name is matched back to the schema", () => {
  it("accepts a schema-qualified answer", async () => {
    const list = tables(2);
    chatSpy.mockImplementation(async () =>
      response(
        JSON.stringify({
          descriptions: {
            "ORDERBATCH.SALESDB_TABLE_1": "Holds submitted jobs.",
            "ORDERBATCH.SALESDB_TABLE_2": "Holds invoice rows.",
          },
        }),
      ),
    );
    const result = await synthesize(list);
    expect(graphDescribed(result.schemaGraph)).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it("accepts a differently-cased answer", async () => {
    const list = tables(2);
    chatSpy.mockImplementation(async () =>
      response(
        JSON.stringify({
          descriptions: { salesdb_table_1: "Holds jobs.", salesdb_table_2: "Holds invoices." },
        }),
      ),
    );
    const result = await synthesize(list);
    expect(graphDescribed(result.schemaGraph)).toBe(2);
    expect(result.markdown).toContain("Holds jobs.");
  });
});

// ---------------------------------------------------------------------------
// Defect 3, end to end: a provider that actually ENFORCES its output cap
// ---------------------------------------------------------------------------

/**
 * A provider whose response is cut at the cap it was given — the one behaviour
 * the repo's stub providers do NOT have, and the reason a missing `maxTokens`
 * passed every existing test (#1224).
 */
function capEnforcingProvider(list: DbTableInfo[], charsPerToken = 4) {
  return async (messages: unknown, opts?: ChatOptions) => {
    const prompt = (messages as Array<{ content: string }>)[0]?.content ?? "";
    const descriptions: Record<string, string> = {};
    for (const t of list) {
      if (!prompt.includes(`Table: ${t.name}`)) continue;
      descriptions[t.name] = describeAtLength(t.name, DESCRIPTION_CHARS_OVER_THE_CLIFF);
    }
    const full = JSON.stringify({ descriptions });
    const limit = (opts?.maxTokens ?? 4096) * charsPerToken;
    const truncated = full.length > limit;
    return response(truncated ? full.slice(0, limit) : full, truncated ? "length" : "stop");
  };
}

/**
 * MEASURED: at the default batch size of 30, a 4096-token cap is about 16,384
 * characters, which leaves roughly 516 characters — some 77 words — per table
 * once the JSON keys and punctuation are paid for. The prompt asks for "2-3
 * sentences", so a model at the verbose end of its own instruction sits right on
 * that line. 600 characters is one such response: three full sentences.
 */
const DESCRIPTION_CHARS_OVER_THE_CLIFF = 600;

function describeAtLength(table: string, chars: number): string {
  const body =
    `Stores the header record for each order booked on the next-day schedule by a customer ` +
    `organisation, keyed by the surrogate identifier in ${table}. Each row captures the ` +
    `submitting customer, the target delivery date and hour, and the lifecycle status of the ` +
    `order as it moves through validation, dispatch and invoicing. Rows are retained for seven ` +
    `years to satisfy the carrier's record retention and audit requirements, and are purged by ` +
    `the nightly housekeeping job once that window has elapsed.`;
  return body.length >= chars ? body.slice(0, chars) : body.padEnd(chars, " ").slice(0, chars);
}

describe("#1228 defect 3 end to end — the cap decides whether ANY description lands", () => {
  it("loses the whole 30-table batch at the pre-#1228 inherited 4096 cap", async () => {
    process.env.DOCS_GEN_DB_SCHEMA_MAX_OUTPUT_TOKENS = "4096";
    const list = tables(30);
    chatSpy.mockImplementation(capEnforcingProvider(list));
    const result = await synthesize(list);

    // One JSON object, no interior braces in the values: overshooting the cap by
    // a single token discards all 30 descriptions, not the tail few.
    expect(graphDescribed(result.schemaGraph)).toBe(0);
    expect(result.markdown).toContain("0 of 30 tables");
    expect(result.warnings.map((w) => w.kind)).toContain("section-truncated");
  });

  it("lands every description at the resolved cap for the same batch and the same model", async () => {
    const list = tables(30);
    chatSpy.mockImplementation(capEnforcingProvider(list));
    const result = await synthesize(list);

    expect(graphDescribed(result.schemaGraph)).toBe(30);
    expect(sectionsWithProse(result.markdown)).toBe(30);
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Over-flagging: a short batch is recorded, but does not fail the document
// ---------------------------------------------------------------------------

describe("#1228 — a batch that lands short is logged but does not degrade", () => {
  it("keeps the document clean when the model skips one table of many", async () => {
    const list = tables(4);
    chatSpy.mockImplementation(async () =>
      response(
        JSON.stringify({
          descriptions: {
            SALESDB_TABLE_1: "Holds jobs.",
            SALESDB_TABLE_2: "Holds invoices.",
            SALESDB_TABLE_3: "Holds audit rows.",
          },
        }),
      ),
    );
    const result = await synthesize(list);

    expect(graphDescribed(result.schemaGraph)).toBe(3);
    // Degrading here would hide the Schema Graph explorer, which the UI gates on
    // status — a heavy price for one undescribed lookup table.
    expect(result.warnings).toEqual([]);
    expect(result.markdown).toContain("3 of 4 tables");
    // …but the shortfall is still on the record. AC #2 asks for it to be LOGGED,
    // which is a separate channel from the warning that degrades the document.
    const logged = logWarn.mock.calls.map((c) => JSON.stringify(c));
    expect(logged.some((l) => l.includes("incomplete-response"))).toBe(true);
  });

  it("still degrades when a batch returns nothing usable", async () => {
    chatSpy.mockImplementation(async () => response("no JSON here"));
    const result = await synthesize(tables(4));

    expect(result.warnings.map((w) => w.kind)).toContain("section-failed");
  });
});

// ---------------------------------------------------------------------------
// Name matching must never LOSE a match an exact comparison would have made
// ---------------------------------------------------------------------------

describe("#1228 resolveTableKey — case-insensitivity never costs an exact match", () => {
  const named = (name: string) => makeTable(name);

  it("keeps two tables that differ only in case distinct", () => {
    // Postgres and MySQL both allow this. Folding them to one key would route
    // both descriptions onto whichever came first and leave the other bare —
    // worse than the unconditional set() this replaced.
    const index = buildTableKeyIndex([named("Foo"), named("foo")]);
    expect(resolveTableKey("Foo", index)).toBe("Foo");
    expect(resolveTableKey("foo", index)).toBe("foo");
  });

  it("refuses to guess when only a case-folded form is offered for an ambiguous name", () => {
    const index = buildTableKeyIndex([named("Foo"), named("foo")]);
    expect(resolveTableKey("FOO", index)).toBeUndefined();
    expect(resolveTableKey("ORDERBATCH.FOO", index)).toBeUndefined();
  });

  it("still folds case and strips a qualifier when the name is unambiguous", () => {
    const index = buildTableKeyIndex([named("ORDER_HEADER")]);
    expect(resolveTableKey("order_header", index)).toBe("ORDER_HEADER");
    expect(resolveTableKey("ORDERBATCH.order_header", index)).toBe("ORDER_HEADER");
    expect(resolveTableKey("  ORDER_HEADER  ", index)).toBe("ORDER_HEADER");
  });

  it("matches nothing for a table that is not in the schema", () => {
    const index = buildTableKeyIndex([named("ORDER_HEADER")]);
    expect(resolveTableKey("SOME_OTHER_TABLE", index)).toBeUndefined();
    expect(resolveTableKey("   ", index)).toBeUndefined();
  });

  it("describes both case-variant tables end to end", async () => {
    const list = [makeTable("Foo"), makeTable("foo")];
    chatSpy.mockImplementation(async () =>
      response(JSON.stringify({ descriptions: { Foo: "Upper variant.", foo: "Lower variant." } })),
    );
    const result = await synthesize(list);

    expect(graphDescribed(result.schemaGraph)).toBe(2);
    expect(result.markdown).toContain("Upper variant.");
    expect(result.markdown).toContain("Lower variant.");
    expect(result.warnings).toEqual([]);
  });
});

describe("#1228 — the banner names only batches that returned nothing", () => {
  it("states no cause when a batch merely landed short", async () => {
    const list = tables(3);
    chatSpy.mockImplementation(async () =>
      response(
        JSON.stringify({
          descriptions: { SALESDB_TABLE_1: "Holds jobs.", SALESDB_TABLE_2: "Holds invoices." },
        }),
      ),
    );
    const result = await synthesize(list);

    expect(result.markdown).toContain("2 of 3 tables");
    // Saying a batch "did not return usable descriptions" would be false: it
    // returned two of three.
    expect(result.markdown).not.toContain("did not return usable descriptions");
  });

  it("names the cause when a batch really did return nothing", async () => {
    chatSpy.mockImplementation(async () => response("sorry, no"));
    const result = await synthesize(tables(3));

    expect(result.markdown).toContain("0 of 3 tables");
    expect(result.markdown).toContain("did not return usable descriptions");
  });
});
