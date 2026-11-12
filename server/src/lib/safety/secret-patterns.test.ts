/**
 * #2333 — the shared secret set: every pattern with a positive and a negative
 * case, line stability, the marker, the false positives source code is full of,
 * and a stated time bound over 1 MB adversarial lines.
 *
 * Every credential-shaped value is BUILT at runtime (`k(...)`), so this file
 * carries none as a literal and no push-protection scanner trips on it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { redactSecrets, SECRET_PATTERNS, secretMarker, secretMatches } from "./secret-patterns.js";

const EVAL_CORPUS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../eval-data/corpus",
);

const k = (...parts: string[]): string => parts.join("");
const B64 = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";

const PEM = [
  k("-----BEGIN ", "RSA PRIVATE KEY-----"),
  B64,
  B64,
  "AbCdEfGh+/==",
  k("-----END ", "RSA PRIVATE KEY-----"),
].join("\n");

const OPENSSH = [
  k("-----BEGIN ", "OPENSSH PRIVATE KEY-----"),
  B64,
  B64,
  k("-----END ", "OPENSSH PRIVATE KEY-----"),
].join("\n");

/** The single-string form a JSON service-account file carries. */
const PEM_ESCAPED = k(
  "-----BEGIN ",
  "PRIVATE KEY-----\\n",
  B64,
  "\\n",
  B64,
  "\\n-----END ",
  "PRIVATE KEY-----\\n",
);

/** One positive and one near-miss negative per class. */
const CASES: ReadonlyArray<{ id: string; positive: string; negative: string }> = [
  {
    id: "private_key",
    positive: PEM,
    negative: k('const HEADER = "-----BEGIN ', 'PRIVATE KEY-----";'),
  },
  {
    id: "url_credentials",
    positive: k("postgres://app:", "s3cr3tPassw0rd", "@db.internal:5432/app"),
    negative: "postgres://${DB_USER}:${DB_PASS}@db.internal:5432/app",
  },
  { id: "aws_key", positive: k("AKIA", "Q3EGRTXXXXZ7Y2WB"), negative: k("AKIA", "short") },
  {
    id: "aws_secret",
    positive: k("aws_secret_access_key = ", '"', "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", '"'),
    negative: 'aws_secret_access_key = "${AWS_SECRET}"',
  },
  { id: "github_pat", positive: k("ghp_", "a".repeat(36)), negative: "ghp_short" },
  {
    id: "anthropic_key",
    positive: k("sk-ant-", "api03-", "b".repeat(40)),
    negative: "sk-ant-short",
  },
  { id: "openai_key", positive: k("sk-proj-", "c".repeat(40)), negative: "sk-learn-pipeline" },
  { id: "slack_token", positive: k("xox", "b-", "1234567890-abcdefghij"), negative: "xoxb-1" },
  {
    id: "slack_webhook",
    positive: k("https://hooks.slack.com/", "services/T0000/B0000/", "X".repeat(24)),
    negative: "https://hooks.slack.com/services/",
  },
  {
    id: "google_api_key",
    positive: k("AIza", "d".repeat(35)),
    negative: k("AIza", "d".repeat(20)),
  },
  { id: "stripe_key", positive: k("sk_", "live_", "e".repeat(24)), negative: "sk_live_" },
  { id: "npm_token", positive: k("npm_", "f".repeat(36)), negative: "npm_install" },
  { id: "gitlab_token", positive: k("glpat-", "g".repeat(20)), negative: "glpat-short" },
  {
    id: "sendgrid_key",
    positive: k("SG.", "h".repeat(22), ".", "i".repeat(43)),
    negative: "SG.module.render",
  },
  { id: "huggingface_token", positive: k("hf_", "j".repeat(34)), negative: "hf_tokenizer_config" },
  {
    id: "pypi_token",
    positive: k("pypi-", "AgEIcHlwaS5vcmc", "k".repeat(60)),
    negative: "pypi-AgEIcHlwaS5vcmc",
  },
  { id: "digitalocean_token", positive: k("dop_", "v1_", "a".repeat(64)), negative: "dop_v1_abc" },
  {
    id: "azure_storage_key",
    positive: k("AccountName=x;AccountKey=", "L".repeat(86), "=="),
    negative: "AccountKey=;EndpointSuffix=core.windows.net",
  },
  { id: "bearer", positive: k("Bearer ", "abcdefghijklmnopqrstuv"), negative: "Bearer ${token}" },
  {
    id: "jwt",
    positive: k("eyJ", "hbGciOi", ".", "eyJ", "zdWIiOi", ".", "SflKxwRJSM"),
    negative: "org.springframework.boot.autoconfigure",
  },
  {
    id: "long_hex",
    positive: "0123456789abcdef".repeat(3),
    negative: "0123456789abcdef".repeat(4),
  },
  {
    id: "assigned_secret",
    positive: k('password = "', "s3cr3t-Pa55", '"'),
    negative: 'password = "${DB_PASSWORD}"',
  },
];

describe("SECRET_PATTERNS", () => {
  it("has exactly one positive/negative case per class, and unique ids", () => {
    const ids = SECRET_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CASES.map((c) => c.id).sort()).toEqual([...ids].sort());
  });

  it.each(CASES)("$id: redacts the positive and names the class", ({ id, positive }) => {
    const out = redactSecrets(`value = ${positive} ;`);
    expect(out.byClass[id]).toBeGreaterThanOrEqual(1);
    expect(out.text).toContain(secretMarker(id));
  });

  it.each(CASES)("$id: leaves the negative alone", ({ negative }) => {
    const input = `value = ${negative} ;`;
    expect(redactSecrets(input)).toEqual({ text: input, count: 0, byClass: {} });
  });

  it("the output keeps no 8-character piece of any matched secret", () => {
    for (const { id, positive } of CASES) {
      const input = `value = ${positive} ;`;
      const out = redactSecrets(input).text;
      const p = SECRET_PATTERNS.find((x) => x.id === id)!;
      const matches = [...secretMatches(p, input)];
      expect(matches.length, id).toBeGreaterThan(0);
      for (const m of matches) {
        for (let i = 0; i + 8 <= m.length; i += 1) {
          const piece = m.slice(i, i + 8);
          if (/\s/.test(piece) || secretMarker(id).includes(piece)) continue;
          expect(out.includes(piece), `${id} leaks ${JSON.stringify(piece)}`).toBe(false);
        }
      }
      expect(secretMarker(id)).toMatch(/^\[REDACTED:[a-z_]+\]$/);
    }
  });

  it("an OpenSSH key and the escaped single-string PEM are both caught", () => {
    expect(redactSecrets(OPENSSH).byClass).toEqual({ private_key: 1 });
    // A service-account file's shape, assembled so no scanner reads this test as one.
    const head = k('{"type":"service', '_account","private', '_key":"');
    const out = redactSecrets(`${head}${PEM_ESCAPED}","x":1}`);
    expect(out.byClass).toEqual({ private_key: 1 });
    // The escaped newline after the END line is JSON, not key: it stays.
    expect(out.text).toBe(`${head}[REDACTED:private_key]\\n","x":1}`);
  });

  it("an unterminated key block with key material is caught; a bare header is not", () => {
    const cut = [k("-----BEGIN ", "PRIVATE KEY-----"), B64, B64].join("\n");
    expect(redactSecrets(cut).count).toBe(1);
    expect(redactSecrets(k("-----BEGIN ", "PRIVATE KEY-----\nshort")).count).toBe(0);
  });

  it("URL credentials: only user:password is replaced; scheme and host stay readable", () => {
    const out = redactSecrets(k("redis://default:", "hunter2hunter2", "@cache:6379"));
    expect(out.text).toBe("redis://[REDACTED:url_credentials]@cache:6379");
    // No password: nothing to redact. A template slot is not a value.
    expect(redactSecrets("ssh://git@github.com:22/org/repo").count).toBe(0);
    expect(redactSecrets("amqp://guest:****@mq/").count).toBe(0);
    expect(redactSecrets("mysql://root:%(pw)s@db/").count).toBe(0);
  });

  it("a password holding a raw '@' is replaced whole, not up to its first '@'", () => {
    const out = redactSecrets(k("postgres://app:", "p@ssw0rd", "@db:5432/app"));
    expect(out.text).toBe("postgres://[REDACTED:url_credentials]@db:5432/app");
    expect(out.text).not.toContain("ssw0rd");
  });

  it("a password that merely starts with '$' or '%' is still a value; named slots are kept", () => {
    expect(redactSecrets(k("mysql://root:", "$ecretPa55", "@db/")).count).toBe(1);
    expect(redactSecrets(k("mysql://root:", "%40pa55w0rd", "@db/")).count).toBe(1);
    expect(redactSecrets("mysql://root:${PASS}@db/").count).toBe(0);
    expect(redactSecrets("mysql://root:$DB_PASS@db/").count).toBe(0);
    expect(redactSecrets("mysql://root:{pw}@db/").count).toBe(0);
  });

  it("a key written as concatenated string literals, and a PGP block, are caught", () => {
    const concatenated = [
      k('String key = "-----BEGIN ', 'PRIVATE KEY-----\\n" +'),
      `    "${B64}\\n" +`,
      `    "${B64}\\n" +`,
      k('    "-----END ', 'PRIVATE KEY-----\\n";'),
    ].join("\n");
    const out = redactSecrets(concatenated);
    expect(out.byClass).toEqual({ private_key: 1 });
    expect(out.text.split("\n")).toHaveLength(4);
    expect(out.text).not.toContain("MIIEvQIB");
    const pgp = [
      k("-----BEGIN PGP ", "PRIVATE KEY BLOCK-----"),
      "",
      B64,
      B64,
      k("-----END PGP ", "PRIVATE KEY BLOCK-----"),
    ].join("\n");
    expect(redactSecrets(pgp).byClass).toEqual({ private_key: 1 });
  });

  it("a consumer cannot leave lastIndex set for the next one: each `re` read is a fresh RegExp", () => {
    const p = SECRET_PATTERNS.find((x) => x.id === "aws_key")!;
    const key = k("AKIA", "Q3EGRTXXXXZ7Y2WB");
    const mine = p.re;
    expect(mine.exec(`x ${key}`)).not.toBeNull(); // a `g` exec leaves lastIndex past the match
    expect(mine.lastIndex).toBeGreaterThan(0);
    expect(p.re).not.toBe(mine);
    expect(p.re.lastIndex).toBe(0);
    expect(p.re.test(key)).toBe(true);
    expect([...secretMatches(p, key)]).toEqual([key]);
    expect(redactSecrets(key).count).toBe(1);
    // The set and each pattern are frozen: a consumer cannot swap one out either.
    expect(Object.isFrozen(SECRET_PATTERNS)).toBe(true);
    expect(Object.isFrozen(p)).toBe(true);
  });

  it("URL credentials: only the whole named-slot shapes are templates", () => {
    for (const slot of ["${PASS}", "{{.pw}}", "{pw}", "%(pw)s", "$DB_PASS", "****"]) {
      expect(redactSecrets(`mysql://root:${slot}@db/`).count, slot).toBe(0);
    }
    // Starts like a slot, but is a value.
    for (const value of ["${PASS}tail9", "{notclosed9", "%(pw)x", "$lowercase1", "**pw**"]) {
      expect(redactSecrets(k("mysql://root:", value, "@db/")).count, value).toBe(1);
    }
  });

  it("an Anthropic key is reported once, as Anthropic — the OpenAI shape excludes it", () => {
    expect(redactSecrets(k("sk-ant-", "api03-", "b".repeat(40))).byClass).toEqual({
      anthropic_key: 1,
    });
  });

  it("only the generic shapes are not high-confidence", () => {
    expect(SECRET_PATTERNS.filter((p) => !p.highConfidence).map((p) => p.id)).toEqual([
      "url_credentials",
      "aws_secret",
      "bearer",
      "jwt",
      "long_hex",
      "assigned_secret",
    ]);
  });

  it("returns the input untouched and counts nothing for empty input", () => {
    expect(redactSecrets("")).toEqual({ text: "", count: 0, byClass: {} });
  });

  it("skip leaves a named class alone", () => {
    const aws = k("AKIA", "Q3EGRTXXXXZ7Y2WB");
    expect(redactSecrets(aws, { skip: new Set(["aws_key"]) }).text).toBe(aws);
  });
});

describe("line stability", () => {
  it("keeps the line count and every unredacted line at its number", () => {
    const file = [
      "package main",
      "",
      "const key = `" + PEM.split("\n")[0],
      ...PEM.split("\n").slice(1),
      "`",
      k('var token = "', "ghp_", "a".repeat(36), '"'),
      "func main() {}",
    ].join("\n");
    const before = file.split("\n");
    const out = redactSecrets(file);
    const after = out.text.split("\n");
    expect(after).toHaveLength(before.length);
    expect(out.count).toBe(2);
    // Every line that held no secret is byte-identical, at the same number.
    for (const [i, line] of before.entries()) {
      if (!after[i].includes("[REDACTED:")) expect(after[i]).toBe(line);
    }
    // The key block's five lines are five marker lines, not one.
    expect(after.slice(2, 7).every((l) => l.includes("[REDACTED:private_key]"))).toBe(true);
    expect(after.at(-1)).toBe("func main() {}");
  });

  it("keeps CRLF line endings", () => {
    const crlf = PEM.replace(/\n/g, "\r\n") + "\r\nnext";
    const out = redactSecrets(crlf).text;
    expect(out.split("\r\n")).toHaveLength(crlf.split("\r\n").length);
    expect(out.endsWith("\r\nnext")).toBe(true);
  });

  it("keeps a line break a `Bearer` match spans", () => {
    const text = k("Authorization: Bearer\n", "abcdefghijklmnopqrstuv");
    expect(redactSecrets(text).text.split("\n")).toHaveLength(2);
  });
});

describe("false positives on source code (#1138)", () => {
  it.each([
    ["a Go pseudo-version (#1138)", "require golang.org/x/net v0.0.0-20210817142637-7d9622a276b7"],
    ["a go.sum line", "golang.org/x/net v0.0.0 h1:2aRbcrnL2KGhOvKt0uA4eZ5eRSZp5Fcw0DzLeAP7aho="],
    ["an MD5 digest", "md5 " + "d41d8cd98f00b204e9800998ecf8427e"],
    ["a git SHA", "commit " + "e83c5163316f89bfbde7d9ab23ca2e25604af290"],
    ["a SHA-256 digest", "a".repeat(64)],
    ["a SHA-384 digest", "b".repeat(96)],
    ["a SHA-512 digest", "c".repeat(128)],
    ["a UUID", "id = 550e8400-e29b-41d4-a716-446655440000"],
    ["a UUID without dashes", "id = 550e8400e29b41d4a716446655440000"],
    [
      "an npm lockfile integrity",
      '"integrity": "sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXGOTVhfiVa+H+Y6s9Q+R7ZBf3T/g=="',
    ],
    [
      "a pnpm lockfile integrity",
      "resolution: {integrity: sha512-Fq7Wd3x/Mn0Q8eFq5c3xg2fCNXGyRpS8Q==}",
    ],
    ["a Docker image digest", "image: node@sha256:" + "9".repeat(64)],
    [
      "a base64 test fixture",
      'const fixture = "SGVsbG8sIFdvcmxkISBUaGlzIGlzIGEgdGVzdCBmaXh0dXJlLg==";',
    ],
    ["a Java package", "import org.springframework.boot.autoconfigure.SpringBootApplication;"],
    ["a phone-looking number", "const MAX = 5551234567;"],
    ["an email address in a comment", "// author: alice@example.com"],
    ["a CSS color", "color: #a3f9c0;"],
  ])("leaves %s alone", (_label, line) => {
    expect(redactSecrets(line)).toEqual({ text: line, count: 0, byClass: {} });
  });
});

describe("assigned_secret: a literal assigned to a password, token or key name", () => {
  const PW = k("s3cr3t", "-Pa55");
  const MARK = secretMarker("assigned_secret");

  it.each([
    [".env", k("DB_PASSWORD=", PW), k("DB_PASSWORD=", MARK)],
    [
      ".env, exported and commented",
      k("export API_KEY=", PW, "  # prod"),
      k("export API_KEY=", MARK, "  # prod"),
    ],
    [".env, quoted", k('CLIENT_SECRET="', PW, '"'), k('CLIENT_SECRET="', MARK, '"')],
    ["YAML", k("  password: ", PW), k("  password: ", MARK)],
    ["YAML list item", k("  - ADMIN_PASSWORD=", PW), k("  - ADMIN_PASSWORD=", MARK)],
    ["YAML, quoted", k("  apiKey: '", PW, "'"), k("  apiKey: '", MARK, "'")],
    [".properties", k("spring.datasource.password=", PW), k("spring.datasource.password=", MARK)],
    [
      "JSON",
      k('{"client_secret": "', PW, '", "x": 1}'),
      k('{"client_secret": "', MARK, '", "x": 1}'),
    ],
    ["Go", k('token := "', PW, '"'), k('token := "', MARK, '"')],
    [
      "Python kwarg",
      k('connect(user="app", passwd="', PW, '")'),
      k('connect(user="app", passwd="', MARK, '")'),
    ],
    ["TS object", k("{ privateKey: `", PW, "` }"), k("{ privateKey: `", MARK, "` }")],
    ["Ruby hash", k(':api_key => "', PW, '"'), k(':api_key => "', MARK, '"')],
  ])("%s: the value is replaced, the name stays readable", (_label, input, expected) => {
    expect(redactSecrets(input)).toEqual({
      text: expected,
      count: 1,
      byClass: { assigned_secret: 1 },
    });
  });

  it.each([
    ["a template slot", 'password: "${DB_PASSWORD}"'],
    ["a Helm value", "password: {{ .Values.db.password }}"],
    ["an angle-bracket placeholder", 'api_key = "<your-api-key>"'],
    ["changeme", "password: changeme123"],
    ["all asterisks", 'password = "********"'],
    ["xxx", "export E2B_API_KEY=e2b_xxx"],
    ["empty", 'password = ""'],
    ["a printf slot", 'password = "%(password)s"'],
    ["a short value", 'token = "abc12"'],
    ["a bare word", 'token: "refresh"'],
    ["a translated label", '"form.user.label.password": "Contraseña"'],
    ["an interpolation", "apiKey: `${secret}-api-key`,"],
    ["a reference", "password = settings.SECRET_KEY"],
    ["a call", "password = get_password()"],
    ["a subscript", 'api_key = os.environ["API_KEY"]'],
    ["a property read", "apiKey: process.env.API_KEY,"],
    ["a TS field type", "  token: string;"],
    ["a Python annotation", "secret: str"],
    ["a Go dereference", "feed.Password = *f.Password"],
    ["a Go short assignment", "password := cfg.Pass1"],
    ["a comparison", 'if password == "hunter22x" {'],
    ["a key path", "private_key: /etc/ssl/private/server.pem"],
    ["a key file name", 'private_key = "server-2024.pem"'],
    ["a URL", 'token_url: "https://auth.example.com/oauth2/token"'],
    ["a URN", 'password: "urn:oasis:names:tc:SAML:2.0:ac:classes:Password"'],
    ["a counter", "max_tokens: 4096"],
    ["a name that only contains the word", 'password_hash = "abc123def456"'],
    ["the word in the value", 'label = "Enter password 12345"'],
  ])("leaves %s alone", (_label, line) => {
    expect(redactSecrets(line)).toEqual({ text: line, count: 0, byClass: {} });
  });

  it("a vendor shape keeps its own class; the assignment does not redact its marker again", () => {
    const out = redactSecrets(k('token = "', "ghp_", "a".repeat(36), '"'));
    expect(out.byClass).toEqual({ github_pat: 1 });
  });

  it("ordinary code stays intact: 3,573 stored symbol texts of the eval corpora", () => {
    // Real Go, Python, JS and TS from the localization corpora (miniflux/v2 and the
    // three fixture repositories), as the code graph stores them.
    const rows = ["localization-01-miniflux-heldout", "localization-02-fixture-portfolio"].flatMap(
      (corpus) =>
        (
          JSON.parse(
            gunzipSync(readFileSync(path.join(EVAL_CORPUS, corpus, "symbols.json.gz"))).toString(
              "utf8",
            ),
          ) as { rows: { id: string; embeddingText: string }[] }
        ).rows,
    );
    expect(rows).toHaveLength(3573);
    const hit = rows.filter((r) => redactSecrets(r.embeddingText).count > 0);
    // The one hit is a credential-shaped literal in a Go test fixture
    // (`client_test.go`: `Token: "token2"`), which the class is meant to take.
    expect(hit.map((r) => [r.id, redactSecrets(r.embeddingText).byClass])).toEqual([
      ["miniflux#00023", { assigned_secret: 1 }],
    ]);
  });
});

describe("linear time", () => {
  /** The stated bound: the whole set over one 1 MB line. Linear patterns take a few ms. */
  const BOUND_MS = 1500;
  const MB = 1024 * 1024;
  const fill = (unit: string): string => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);

  // A long run of each pattern's own body class, and each prefix repeated
  // back to back with no valid ending, are the shapes that make an
  // unanchored or nested quantifier rescan the same run from every start.
  const adversarial: ReadonlyArray<[string, string]> = [
    ["one word run", fill("a")],
    ["dash-separated word chars", fill("a-")],
    ["dotted runs", fill("eyJaaaaa.")],
    ["repeated key headers", fill(k("-----BEGIN ", "PRIVATE KEY-----"))],
    [
      "a key header then 1 MB of body with no end",
      k("-----BEGIN ", "PRIVATE KEY-----") + fill("A"),
    ],
    ["repeated URL schemes", fill("a://")],
    ["a scheme then a long password with no @", "a://u:" + fill("p")],
    ["repeated sk- prefixes", fill("sk-")],
    ["repeated sk-ant- prefixes", fill("sk-ant-")],
    ["repeated ghp_ prefixes", fill("ghp_")],
    ["repeated glpat- prefixes", fill("glpat-")],
    ["repeated xoxb- prefixes", fill("xoxb-")],
    ["repeated pypi prefixes", fill("pypi-AgEIcHlwaS5vcmc-")],
    ["repeated Bearer", fill("Bearer ")],
    ["hex separated by dashes", fill("0123456789abcdef-")],
    ["whitespace", fill(" \t")],
    ["repeated quoted assignments", fill('password="')],
    ["repeated unquoted assignments", fill("token=")],
    ["an assignment then 1 MB of value", "api_key=" + fill("a1")],
    ["a quoted assignment then 1 MB with no closing quote", 'secret: "' + fill("a1")],
    ["a long name before the keyword", fill("a.") + "password=" + "a1".repeat(20)],
  ];

  it.each(adversarial)(`redacts %s (1 MB) within ${BOUND_MS} ms`, (_label, line) => {
    const t0 = performance.now();
    const out = redactSecrets(line);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(BOUND_MS);
    expect(out.text.split("\n")).toHaveLength(line.split("\n").length);
  });

  it("no pattern quantifies a group that itself holds an unbounded quantifier", () => {
    // `( … + … )*` and kin are the backtracking shape; every group here that is
    // quantified holds only single characters or bounded repeats.
    const nested =
      /\((?:\?(?:[:!=]|<[=!]))?(?:[^()\\]|\\.)*(?:[+*]|\{\d+,\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/;
    // The detector itself can fail: it flags the classic shapes.
    for (const bad of ["(?:a+)+", "(a*b)*", "(?:[a-z]{2,})+"])
      expect(nested.test(bad), bad).toBe(true);
    for (const p of SECRET_PATTERNS) {
      expect(nested.test(p.re.source), `${p.id}: ${p.re.source}`).toBe(false);
    }
  });
});
