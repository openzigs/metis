/**
 * #1578 — the consistency check's readings against the source: a hex length
 * given as a byte count, a data-dictionary default that is not the database's,
 * and a main-part value with no citation. Shapes from #706 run 10's BRD.
 */
import { describe, expect, it } from "vitest";
import { expectLinearTime } from "../../../tests/helpers/linear-time.js";
import type { SchemaInventory } from "./schema-inventory.js";
import {
  columnDefaultFindings,
  givesValue,
  hexLengthFindings,
  mainStatements,
  proseLines,
  scanHexLengths,
  schemaDefaultLiteral,
  statedDefaultLiteral,
  uncitedMainFindings,
  type EncodedLengthFact,
} from "./source-claim-checks.js";

/** The calls Miniflux makes (`internal/crypto/crypto.go` callers). */
const CALLS: EncodedLengthFact[] = [
  {
    bytes: 32,
    characters: 64,
    expression: "GenerateRandomStringHex(32)",
    source: "internal/storage/api_key.go:41",
  },
  {
    bytes: 20,
    characters: 40,
    expression: "GenerateRandomStringHex(20)",
    source: "internal/storage/entry.go:612",
  },
];

describe("scanHexLengths", () => {
  it("reads every shape run 10 wrote a hex length in", () => {
    const text = [
      "**Generated identifiers** — API key tokens are **32 hex characters**, share codes are **20 hex characters**.",
      "verifier = 32-char random hex; state = 24-char random hex.",
      "| `id` | int64 | PK | — | — | Entry identifier (exposed as a 16-hex Google Reader item ID) |",
      "A 64-character lowercase hex string, a 40‑hexadecimal-digit code.",
    ].join("\n");
    expect(scanHexLengths(text).map((s) => [s.length, s.line])).toEqual([
      [32, 1],
      [20, 1],
      [32, 2],
      [24, 2],
      [16, 3],
      [64, 4],
      [40, 4],
    ]);
  });

  it("does not read a length in another unit, a version or a number inside a word", () => {
    const text = [
      "A 32-character API token and 32 random bytes.",
      "Version 1.32 hex characters, v2-hex, abc32 hex characters, 1,32 hex characters.",
    ].join("\n");
    expect(scanHexLengths(text)).toEqual([]);
  });

  it("skips fenced code and $$ blocks", () => {
    const text = ["```go", "// 32 hex characters", "```", "$$", "32 hex characters", "$$"].join(
      "\n",
    );
    expect(scanHexLengths(text)).toEqual([]);
  });
});

describe("hexLengthFindings", () => {
  const sections = [
    {
      label: "Data & Domain Model",
      markdown:
        "API key tokens are **32 hex characters**, share codes are **20 hex characters** [facts:a:0].",
    },
    {
      label: "Business Rules & Policies",
      markdown: "A share code is a 40-character hex string; a token has 64 hex characters.",
    },
  ];

  it("reports a length that is a call's byte count and no call's character count", () => {
    const { findings, compared, statements } = hexLengthFindings(sections, CALLS);
    expect(statements).toBe(4);
    expect(compared).toBe(4);
    expect(findings).toEqual([
      {
        kind: "byte-length",
        name: "32 hex characters",
        canonical: {
          value: "GenerateRandomStringHex(32) returns 64 hex characters (32 bytes)",
          source: "internal/storage/api_key.go:41",
        },
        statements: [{ section: "Data & Domain Model", line: 1, value: "32 hex characters" }],
        sections: 1,
        forms: 2,
      },
      expect.objectContaining({
        kind: "byte-length",
        name: "20 hex characters",
        canonical: expect.objectContaining({ source: "internal/storage/entry.go:612" }),
      }),
    ]);
  });

  it("leaves a length alone when some call returns that many characters", () => {
    // 20 bytes of one call, but 40 characters of another: no finding for 40,
    // and none for 20 when a call returns 20 characters.
    const calls = [...CALLS, { ...CALLS[0], bytes: 10, characters: 20, expression: "X(10)" }];
    const { findings } = hexLengthFindings(sections, calls);
    expect(findings.map((f) => f.name)).toEqual(["32 hex characters"]);
  });

  it("finds nothing without calls, and does not compare a length no call has", () => {
    expect(hexLengthFindings(sections, []).findings).toEqual([]);
    const other = [{ label: "S", markdown: "A 16-hex item ID." }];
    expect(hexLengthFindings(other, CALLS)).toEqual({ findings: [], statements: 1, compared: 0 });
  });
});

/** A live read of Miniflux's schema, as `tablesFromIntrospection` keeps it. */
const INVENTORY: SchemaInventory = {
  source: "live-schema",
  label: 'the live schema of "miniflux" (public)',
  reads: [{ connector: "miniflux", how: "live", schemas: ["public"] }],
  tables: [
    {
      schema: "public",
      name: "feeds",
      read: 0,
      foreignKeys: [],
      columns: [
        {
          name: "id",
          dataType: "bigint",
          nullable: false,
          isPrimaryKey: true,
          isForeignKey: false,
        },
        {
          name: "parsing_error_count",
          dataType: "integer",
          nullable: true,
          isPrimaryKey: false,
          isForeignKey: false,
          defaultValue: "0",
        },
        {
          name: "crawler",
          dataType: "boolean",
          nullable: true,
          isPrimaryKey: false,
          isForeignKey: false,
          defaultValue: "false",
        },
        {
          name: "etag_header",
          dataType: "text",
          nullable: true,
          isPrimaryKey: false,
          isForeignKey: false,
          defaultValue: "''::text",
        },
        {
          name: "checked_at",
          dataType: "timestamp with time zone",
          nullable: true,
          isPrimaryKey: false,
          isForeignKey: false,
          defaultValue: "now()",
        },
      ],
    },
    {
      schema: "public",
      name: "entries",
      read: 0,
      foreignKeys: [],
      columns: [
        {
          name: "status",
          dataType: "USER-DEFINED",
          nullable: true,
          isPrimaryKey: false,
          isForeignKey: false,
          defaultValue: "'unread'::entry_status",
        },
        {
          name: "starred",
          dataType: "boolean",
          nullable: true,
          isPrimaryKey: false,
          isForeignKey: false,
          defaultValue: "false",
        },
      ],
    },
    {
      schema: "public",
      name: "users",
      read: 0,
      foreignKeys: [],
      columns: [
        {
          name: "entries_per_page",
          dataType: "integer",
          nullable: true,
          isPrimaryKey: false,
          isForeignKey: false,
          defaultValue: "100",
        },
        {
          name: "theme",
          dataType: "text",
          nullable: true,
          isPrimaryKey: false,
          isForeignKey: false,
        },
      ],
    },
  ],
};

const DICTIONARY = [
  "## Data & Domain Model",
  "",
  "#### FEED",
  "",
  "| Field | Type | Constraint | Default | Range/Allowed values | Description |",
  "|---|---|---|---|---|---|",
  "| `id` | int64 | PK | — | — | Feed identifier |",
  "| `parsing_error_count`, `parsing_error_msg` | int, string | reset on success | `0` | ≥ 0 | Feed health |",
  "| `crawler`, `disabled` | bool | optional | `true` | — | Flags |",
  "| `etag_header` | string | optional | empty | — | Conditional fetch |",
  "| `checked_at` | timestamp | — | `now()` | — | Last poll |",
  "| `category_id` | int64 | FK | first category | — | Grouping |",
  "",
  "#### ENTRY",
  "",
  "| Field | Type | Default |",
  "|---|---|---|",
  "| `status` | enum | `read` |",
  "| `starred` | bool | false |",
  "",
  "#### User settings",
  "",
  "| Field | Type | Default |",
  "|---|---|---|",
  "| `users.entries_per_page` | int | **50** |",
  "| `theme` | text | `system_serif` |",
].join("\n");

describe("columnDefaultFindings", () => {
  it("reports each row whose literal default is not the one the database declares", () => {
    const { findings, compared } = columnDefaultFindings(
      [{ label: "Data & Domain Model", markdown: DICTIONARY }],
      INVENTORY,
    );
    expect(findings.map((f) => [f.name, f.canonical?.value, f.statements[0].value])).toEqual([
      ["feeds.crawler", "false", "crawler: true"],
      ["entries.status", "'unread'::entry_status", "status: read"],
      ["users.entries_per_page", "100", "users.entries_per_page: **50**"],
    ]);
    expect(findings[0]).toMatchObject({
      kind: "column-default",
      canonical: { source: 'the live schema of "miniflux" (public)' },
      statements: [{ section: "Data & Domain Model", line: 9 }],
      sections: 1,
      forms: 2,
    });
    // parsing_error_count 0 = 0, crawler, etag_header '' = empty, status,
    // starred false = false, entries_per_page: six compared.
    expect(compared).toBe(6);
  });

  it("does not judge prose, an expression, a column with no default or a table it cannot name", () => {
    const text = [
      "#### Feed or Entry",
      "",
      "| Field | Default |",
      "|---|---|",
      "| `starred` | `true` |",
      "",
      "#### Settings",
      "",
      "| Field | Default |",
      "|---|---|",
      "| `theme` | `dark` |",
    ].join("\n");
    expect(columnDefaultFindings([{ label: "S", markdown: text }], INVENTORY).findings).toEqual([]);
  });

  it("finds nothing without a schema, or with one that declares no default", () => {
    const sections = [{ label: "S", markdown: DICTIONARY }];
    expect(columnDefaultFindings(sections, undefined).findings).toEqual([]);
    const bare: SchemaInventory = {
      ...INVENTORY,
      tables: INVENTORY.tables.map((t) => ({
        ...t,
        columns: t.columns.map(({ defaultValue: _drop, ...c }) => c),
      })),
    };
    expect(columnDefaultFindings(sections, bare)).toEqual({
      findings: [],
      statements: 0,
      compared: 0,
    });
  });

  it("does not take a table-shaped line without a delimiter row for a table", () => {
    const text = ["#### FEED", "| Field | Default |", "| `crawler` | `true` |"].join("\n");
    expect(columnDefaultFindings([{ label: "S", markdown: text }], INVENTORY).findings).toEqual([]);
  });
});

describe("default literals", () => {
  it.each([
    ["0", "number:0"],
    ["'unread'::entry_status", "text:unread"],
    ["''::character varying", "text:"],
    ["('it''s'::text)", "text:it's"],
    ["FALSE", "boolean:false"],
    ["unread", "text:unread"],
    ["now()", null],
    ["CURRENT_TIMESTAMP", null],
    ["nextval('feeds_id_seq'::regclass)", null],
  ])("schema %s → %s", (raw, expected) => {
    expect(schemaDefaultLiteral(raw)).toBe(expected);
  });

  it.each([
    ["`0`", "number:0"],
    ["**50**", "number:50"],
    ["`'unread'`", "text:unread"],
    ["`unread`", "text:unread"],
    ['"en_US"', "text:en_US"],
    ["empty", "text:"],
    ["false", "boolean:false"],
    ["—", null],
    ["`NULL`", null],
    ["unread", null],
    ["first category", null],
    ["empty/false", null],
    ["`now()`", null],
    ["", null],
  ])("stated %s → %s", (cell, expected) => {
    expect(statedDefaultLiteral(cell)).toBe(expected);
  });
});

describe("uncited values in the main part", () => {
  it("reads a value as a number with a unit or noun, a percentage or a spelled duration", () => {
    expect(givesValue("at most 1,000 articles per request")).toBe(true);
    expect(givesValue("after 60 days")).toBe(true);
    expect(givesValue("a 5-second deadline")).toBe(true);
    expect(givesValue("25% of the budget")).toBe(true);
    expect(givesValue("times out after ten seconds")).toBe(true);
    expect(givesValue("disable HTTP/2 when a server requires it")).toBe(false);
    expect(givesValue("Miniflux v2.3.3 and OAuth2 sign-in")).toBe(false);
    expect(givesValue("1. Sign in with a password")).toBe(false);
    expect(givesValue("see [facts:repo%3A1:12] and https://example.com/page/12 for more")).toBe(
      false,
    );
  });

  it("splits a section into list items, table rows and paragraphs with their continuation lines", () => {
    const text = [
      "## Key Business Rules",
      "",
      "> **Note:** a note METIS adds, after 3 days.",
      "",
      "1. **The health check answers OK** within 5 seconds,",
      "   independent of the database [facts:a:0].",
      "2. Passwords need 6 characters.",
      "",
      "A paragraph over",
      "two lines.",
      "",
      "| Limit | Value |",
      "|---|---|",
      "| Entries | 1,000 entries |",
      "---",
    ].join("\n");
    expect(mainStatements(text)).toEqual([
      {
        text: "1. **The health check answers OK** within 5 seconds, independent of the database [facts:a:0].",
        line: 5,
      },
      { text: "2. Passwords need 6 characters.", line: 7 },
      { text: "A paragraph over two lines.", line: 9 },
      { text: "| Limit | Value |", line: 12 },
      { text: "| Entries | 1,000 entries |", line: 14 },
    ]);
  });

  it("reports, per main section, the statements of a value that cite nothing", () => {
    const sections = [
      {
        label: "Key Business Rules",
        main: true,
        markdown: [
          "1. Outbound calls time out after ten seconds [facts:repo:1].",
          "2. The health check always answers OK within 3 seconds.",
          "3. Every person sees only their own subscriptions.",
          "4. Passwords need at least 6 characters.",
        ].join("\n"),
      },
      { label: "Business Rules & Policies", markdown: "- Retries 5 times." },
    ];
    const { findings, statements, compared } = uncitedMainFindings(sections);
    expect(statements).toBe(3);
    expect(compared).toBe(0);
    expect(findings).toEqual([
      {
        kind: "uncited",
        name: "Key Business Rules",
        statements: [
          {
            section: "Key Business Rules",
            line: 2,
            value: "2. The health check always answers OK within 3 seconds.",
          },
          {
            section: "Key Business Rules",
            line: 4,
            value: "4. Passwords need at least 6 characters.",
          },
        ],
        sections: 1,
        forms: 2,
      },
    ]);
  });

  it("does not join a statement across a fenced block", () => {
    const text = ["Before the diagram", "```mermaid", "graph LR", "```", "after 5 days."].join(
      "\n",
    );
    expect(mainStatements(text).map((s) => s.line)).toEqual([1, 5]);
  });
});

describe("proseLines", () => {
  it("skips fences, $$ blocks and an unclosed $$ block past its limit, and drops a CR", () => {
    const text = ["a\r", "~~~", "b", "~~~", "$$", "c", "$$", "d", "$$x$$", "e"].join("\n");
    expect(proseLines(text).map((l) => l.text)).toEqual(["a", "d", "$$x$$", "e"]);
  });
});

describe("linear time", () => {
  it("reads repeated near-matches in linear time", () => {
    for (const [label, unit] of [
      ["hex lengths", "12-char a b c 12 hex 12-"],
      ["values", "1,1,1,1,1,1,1,1,1 "],
      ["citations", "[facts:".padEnd(30, "x")],
    ] as const) {
      expectLinearTime(`source checks: ${label}`, (size) => {
        const line = unit.repeat(Math.ceil(size / unit.length));
        const sections = [{ label: "S", main: true, markdown: line }];
        return () => {
          hexLengthFindings(sections, CALLS);
          uncitedMainFindings(sections);
        };
      });
    }
    expectLinearTime("source checks: table rows", (size) => {
      const rows = "| `crawler` | `true` |\n".repeat(Math.ceil(size / 23));
      const text = `#### FEED\n| Field | Default |\n|---|---|\n${rows}`;
      return () => columnDefaultFindings([{ label: "S", markdown: text }], INVENTORY);
    });
  });
});
