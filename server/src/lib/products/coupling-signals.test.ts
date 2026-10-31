/**
 * #1619 — the topic and table signals the product crawl extracts.
 */
import { describe, expect, it } from "vitest";
import { expectLinearTime } from "../../../tests/helpers/linear-time.js";
import {
  extractTableRefs,
  extractTopicRefs,
  isAsyncApiDocument,
  lexSource,
  parseAsyncApiChannels,
} from "./coupling-signals.js";

const topics = (path: string, text: string) =>
  extractTopicRefs(path, text).map((r) => `${r.role}:${r.topic}`);
const tables = (path: string, text: string) =>
  extractTableRefs(path, text).map((r) => `${r.access}:${r.table}`);

describe("lexSource", () => {
  it("blanks line and block comments but keeps strings that contain comment markers", () => {
    const src = 'const u = "http://x/y"; // gone\n/* also\ngone */ const t = `a/*b*/`;';
    const { code, strings } = lexSource(src, "a.ts");
    expect(code).toContain('"http://x/y"');
    expect(code).not.toContain("gone");
    expect(code).toContain("`a/*b*/`");
    expect(code.split("\n")).toHaveLength(src.split("\n").length);
    expect(strings.map((s) => s.value)).toEqual(["http://x/y", "a/*b*/"]);
  });

  it("uses the file's own comment syntax and leaves unknown files alone", () => {
    expect(lexSource("x = 1 # note", "a.py").code).not.toContain("note");
    expect(lexSource("select 1 -- note", "a.sql").code).not.toContain("note");
    expect(lexSource("a // b", "README.md").code).toBe("a // b");
  });

  it("handles escapes and an unterminated string", () => {
    const { strings } = lexSource("a = 'it\\'s'\nb = \"open\nc = 1 # c", "a.py");
    expect(strings.map((s) => s.value)).toEqual(["it\\'s", "open"]);
  });
});

describe("extractTopicRefs", () => {
  it("reads the producer and consumer calls of the common clients", () => {
    expect(
      topics(
        "src/a.ts",
        `await producer.send({ topic: 'orders.created', messages });
         await consumer.subscribe({ topic: "payments.settled" });
         await consumer.subscribe({ topics: ["a.one", 'a.two'] });
         nc.publish("audit/events", data);
         sub.subscribe('alerts');
         producer.produce('legacy-topic', null, buf);`,
      ),
    ).toEqual([
      "publish:orders.created",
      "publish:legacy-topic",
      "publish:audit/events",
      "subscribe:payments.settled",
      "subscribe:a.one",
      "subscribe:a.two",
      "subscribe:alerts",
    ]);
    expect(
      topics(
        "src/A.java",
        `@KafkaListener(id = "x", topics = "orders.created") void on(String m) {}
         kafkaTemplate.send("invoices", payload);`,
      ),
    ).toEqual(["publish:invoices", "subscribe:orders.created"]);
    expect(
      topics(
        "worker.py",
        `c = KafkaConsumer('orders.created', group_id='g')\nc.subscribe(['payments'])\nproducer.send('receipts', b'x')`,
      ),
    ).toEqual(["publish:receipts", "subscribe:payments", "subscribe:orders.created"]);
  });

  it("ignores a call that appears only in a comment (false-positive guard)", () => {
    expect(
      topics(
        "src/a.ts",
        `// consumer.subscribe({ topic: "inventory.reserved" })
         /* producer.send({ topic: "inventory.reserved" }) */`,
      ),
    ).toEqual([]);
    expect(topics("worker.py", `# producer.send('receipts', b'x')`)).toEqual([]);
  });

  it("does not read YAML, SQL or unknown files as code", () => {
    expect(topics("x.yaml", `producer.send({ topic: 'a' })`)).toEqual([]);
    expect(topics("README.md", `producer.send({ topic: 'a' })`)).toEqual([]);
  });

  it("reports one ref per role and topic in a file, with its line", () => {
    const refs = extractTopicRefs("a.ts", `\n\nconsumer.subscribe('t');\nconsumer.subscribe('t');`);
    expect(refs).toEqual([
      { topic: "t", role: "subscribe", filePath: "a.ts", lineNumber: 3, source: "code" },
    ]);
  });
});

describe("parseAsyncApiChannels", () => {
  it("2.x: a channel's subscribe operation is what the application publishes", () => {
    const doc = `asyncapi: '2.6.0'
channels:
  orders.created:
    subscribe:
      message: { name: OrderCreated }
  payments.settled:
    publish:
      message: { name: PaymentSettled }`;
    expect(isAsyncApiDocument(doc)).toBe(true);
    expect(parseAsyncApiChannels("asyncapi.yaml", doc)).toEqual([
      { topic: "orders.created", role: "publish" },
      { topic: "payments.settled", role: "subscribe" },
    ]);
  });

  it("3.x: operations send and receive through a channel ref, the address is the topic", () => {
    const doc = JSON.stringify({
      asyncapi: "3.0.0",
      channels: { created: { address: "orders.created" }, settled: {} },
      operations: {
        a: { action: "send", channel: { $ref: "#/channels/created" } },
        b: { action: "receive", channel: { $ref: "#/channels/settled" } },
        c: { action: "receive", channel: { $ref: "#/channels/missing" } },
        d: { action: "send", channel: { $ref: "elsewhere.yaml#/x" } },
      },
    });
    expect(parseAsyncApiChannels("asyncapi.json", doc)).toEqual([
      { topic: "orders.created", role: "publish" },
      { topic: "settled", role: "subscribe" },
    ]);
  });

  it("yields nothing for a document that does not parse or is not AsyncAPI", () => {
    expect(parseAsyncApiChannels("asyncapi.yaml", "asyncapi: [unclosed")).toEqual([]);
    expect(parseAsyncApiChannels("asyncapi.yaml", "openapi: 3.0.0\nchannels: {}")).toEqual([]);
    expect(isAsyncApiDocument("openapi: 3.0.0")).toBe(false);
  });
});

describe("extractTableRefs", () => {
  it("reads writes and reads in a .sql file, not in its comments", () => {
    expect(
      tables(
        "db/q.sql",
        `-- DELETE FROM audit_log;
         INSERT INTO public.orders (id) VALUES (1);
         SELECT o.id FROM orders o JOIN "Customers" c ON c.id = o.cid;
         MERGE INTO ledger USING x ON (1=1);
         DELETE FROM carts WHERE id = 1;
         SELECT * FROM generate_series(1, 3);`,
      ),
    ).toEqual([
      "write:public.orders",
      "write:carts",
      "write:ledger",
      "read:orders",
      "read:customers",
    ]);
  });

  it("in code, scans only string literals that open with a SQL verb", () => {
    expect(
      tables(
        "a.py",
        `Q = "SELECT total FROM orders WHERE id = %s"\nH = "Totals come from the writer"\nU = 'update orders set total = 0'`,
      ),
    ).toEqual(["write:orders"]);
    expect(tables("a.ts", `// "SELECT * FROM secrets"\nconst s = "select 1";`)).toEqual([]);
  });

  it("lets a write win over a read of the same table in one file", () => {
    expect(tables("q.sql", "SELECT * FROM orders; UPDATE orders SET a = 1;")).toEqual([
      "write:orders",
    ]);
    expect(extractTableRefs("q.sql", "\nUPDATE orders SET a = 1;")[0].lineNumber).toBe(2);
  });

  it("does not read YAML or unknown files", () => {
    expect(tables("x.yml", "q: SELECT * FROM orders")).toEqual([]);
    expect(tables("notes.txt", "SELECT * FROM orders")).toEqual([]);
  });

  it("does not read UI prose that opens with a SQL verb as SQL (#1647)", () => {
    expect(
      tables(
        "a.tsx",
        `const a = "Select from the list";\nconst b = "Delete from cart";\nconst c = "Select an item from the menu";\nconst d = "Update your settings";\nconst e = "select one from the list, then save";`,
      ),
    ).toEqual([]);
    // A sentence-cased literal is still SQL when something only SQL has follows.
    expect(
      tables(
        "a.ts",
        `const q = "Select * from orders";\nconst w = "Delete from carts where id = ?";\nconst l = "select id from ledger";`,
      ),
    ).toEqual(["read:orders", "write:carts", "read:ledger"]);
  });

  it("reads no table from a FROM that names none (#1647)", () => {
    expect(
      tables(
        "q.sql",
        `SELECT EXTRACT(YEAR FROM created_at), TRIM(LEADING '0' FROM code),
                SUBSTRING(name FROM 2 FOR 3), POSITION('x' IN s) FROM orders o
          WHERE o.a IS DISTINCT FROM o.b AND o.c IS NOT DISTINCT FROM o.d;
         WITH recent AS (SELECT * FROM events), totals (n) AS MATERIALIZED (SELECT 1 FROM ledger)
         SELECT * FROM recent JOIN totals ON 1 = 1;`,
      ),
    ).toEqual(["read:orders", "read:events", "read:ledger"]);
    // A CTE is only its own statement's: the same name elsewhere is a table.
    expect(tables("q.sql", "WITH t AS (SELECT 1) SELECT * FROM t; SELECT * FROM t;")).toEqual([
      "read:t",
    ]);
  });
});

describe("string literals and docstrings (#1647)", () => {
  it("lexes Python's triple-quoted strings, across lines", () => {
    const src = 'q = """\nSELECT * FROM "orders"\n"""\nr = \'\'\'it\'s\'\'\'\n# done';
    const { strings, code } = lexSource(src, "a.py");
    expect(strings.map((s) => s.value)).toEqual(['\nSELECT * FROM "orders"\n', "it's"]);
    expect(code).not.toContain("done");
    expect(tables("a.py", src)).toEqual(["read:orders"]);
  });

  it("finds no topic in a call written inside a string or a docstring", () => {
    expect(
      topics(
        "a.py",
        `def f():\n    """Example: producer.send('orders.created', v)"""\n    log("call client.publish('audit') to emit")\n    consumer.subscribe(['payments'])`,
      ),
    ).toEqual(["subscribe:payments"]);
    expect(topics("a.ts", "const help = `kafka.produce('x')`; client.publish('real');")).toEqual([
      "publish:real",
    ]);
  });
});

describe("AsyncAPI channel references (#1647)", () => {
  it("decodes JSON-pointer escapes and ignores an inherited name", () => {
    const doc = JSON.stringify({
      asyncapi: "3.0.0",
      channels: { "orders/created": {}, "a~b": { address: "tilde.topic" } },
      operations: {
        a: { action: "send", channel: { $ref: "#/channels/orders~1created" } },
        b: { action: "receive", channel: { $ref: "#/channels/a~0b" } },
        c: { action: "send", channel: { $ref: "#/channels/constructor" } },
        d: { action: "send", channel: { $ref: "#/channels/__proto__" } },
      },
    });
    expect(parseAsyncApiChannels("asyncapi.json", doc)).toEqual([
      { topic: "orders/created", role: "publish" },
      { topic: "tilde.topic", role: "subscribe" },
    ]);
  });
});

// A crawled repo is untrusted text: no input may make a scan super-linear.
describe("scan cost on hostile input", () => {
  it.each([
    ["SELECTs with no FROM", "select ", "q.sql"],
    ["FROMs in one SELECT", "select from a ", "q.sql"],
    ["unique tables", "", "q.sql"],
    ["subscribe calls", "c.subscribe('t", "a.ts"],
    ["unique topics", "", "a.ts"],
    ["KafkaListener openers", "@KafkaListener(", "A.java"],
    ["open block comment", "/*", "a.ts"],
    // #1647 — the new passes: nested no-table FROM calls, CTE openers, an
    // unterminated docstring, and topic calls inside one string.
    ["nested EXTRACT calls", "select extract(", "q.sql"],
    ["CTE openers", "with x as (select 1 from y), ", "q.sql"],
    ["DISTINCT FROMs", "select a is distinct from ", "q.sql"],
    ["unterminated docstring", '"""', "a.py"],
    ["calls inside one string", "' c.publish('t') '", "a.ts"],
  ])("is linear in the size of %s", (label, unit, path) => {
    expectLinearTime(label, (n) => {
      let text: string;
      if (label === "unique tables") {
        text = Array.from({ length: n / 30 }, (_, i) => `INSERT INTO t${i} VALUES (1);\n`).join("");
      } else if (label === "nested EXTRACT calls") {
        const depth = Math.ceil(n / 9);
        text = `select ${"extract(".repeat(depth)}${")".repeat(depth)} from t`;
      } else if (label === "unique topics") {
        text = Array.from({ length: n / 30 }, (_, i) => `c.subscribe('topic-${i}');\n`).join("");
      } else {
        text = unit.repeat(Math.ceil(n / unit.length));
      }
      return () => {
        extractTableRefs(path, text);
        extractTopicRefs(path, text);
      };
    });
  });
});
