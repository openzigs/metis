/**
 * #2333 — the ONE set of secret shapes, and the one function that redacts them.
 *
 * Every consumer imports from here and keeps no copy of its own
 * (`tests/secret-patterns.single-source.test.ts` fails on a copy):
 *
 *   - `connectors/pii-redactor.ts` — connector data (DB rows, Atlassian pages,
 *     the repo overview and manifests) runs this set, then its own PII set;
 *   - `agent-runtime/secret-scan.ts` — refuses an agent or skill definition that
 *     carries a {@link SecretPattern.highConfidence} match;
 *   - repository SOURCE at ingest (`connectors/connector-ingest.ts`), code-graph
 *     symbol text at write time (`code-graph/ingest.ts`) and `read_file_slice` at
 *     read time (`analysis/tools/read-file-slice.ts`) call {@link redactSecrets}.
 *     A new read path over repository text (grep and list tools, #2327; MCP
 *     results, #2331) calls it too.
 *
 * Secrets only. PII (phone, email, SSN, card) is NOT here: on source code those
 * patterns rewrite version strings and test data (#1138 read a Go
 * pseudo-version as a phone number), so they stay in the connector redactor.
 *
 * Three properties every pattern keeps, each pinned by a test:
 *
 *   1. LINE-STABLE. A match is replaced in place, one marker per line it spans,
 *      and its line breaks are kept: a file has the same line count and every
 *      line the same number after redaction, so a citation or a symbol's span
 *      read before it is still right after it.
 *   2. LINEAR-TIME. No quantified group holds an unbounded quantifier, and a
 *      pattern whose body class can contain its own prefix starts only where no
 *      body character precedes it (a lookbehind), so overlapping candidate
 *      starts cannot each rescan the same run.
 *   3. THE MARKER NAMES THE CLASS, never any part of the secret:
 *      `[REDACTED:<id>]`. A caller logs {@link SecretRedaction.count} and
 *      {@link SecretRedaction.byClass}, never a match.
 *
 * Redaction is defence in depth: it does not replace the path refusals
 * (`chat-read-file-slice.ts`) or the per-document ACL filter.
 */

export interface SecretPattern {
  /** The class: the marker reads `[REDACTED:<id>]`. Also the id `PII_REDACT_DISABLE_PATTERNS` names. */
  readonly id: string;
  /** What a person is told was found ("AWS access key id"); never the value. */
  readonly kind: string;
  /**
   * Global. Linear-time: see the module comment. A FRESH RegExp on every read,
   * so no consumer can leave `lastIndex` set for the next one (a `g` RegExp is
   * stateful under `exec` and `test`).
   */
  readonly re: RegExp;
  /**
   * A vendor-specific prefix or a key block: specific enough to REFUSE a save
   * on (`secret-scan.ts`). The rest (`Bearer …`, a JWT, a long hex string, URL
   * credentials) are redacted but never block anything.
   */
  readonly highConfidence: boolean;
  /** Return false to keep a match that is not a secret (a digest, a placeholder). */
  readonly accept?: (match: string, input: string, offset: number) => boolean;
  /**
   * For a {@link highConfidence} pattern: return false for a match that is
   * still redacted but must never refuse a save (a vendor's published test key).
   */
  readonly refuse?: (match: string) => boolean;
}

/** A spec's `re` returns its regex LITERAL, so each call evaluates a new RegExp object. */
type PatternSpec = Omit<SecretPattern, "re"> & { readonly re: () => RegExp };

/** Freeze a spec, exposing `re` as a fresh RegExp on every read. */
function secretPattern(spec: PatternSpec): SecretPattern {
  const { re, ...rest } = spec;
  const p = { ...rest } as SecretPattern;
  Object.defineProperty(p, "re", { get: re, enumerable: true });
  return Object.freeze(p);
}

/** Base64 characters a private-key body must hold before an unterminated block counts. */
const MIN_KEY_BODY_CHARS = 64;

/**
 * A key block with no key in it — a parser's header constant, a doc line that
 * names the format — is not a secret. A real one carries far more than
 * {@link MIN_KEY_BODY_CHARS} base64 characters, terminated or cut short.
 */
function hasKeyBody(match: string): boolean {
  const body = match
    .replace(/^-----BEGIN [A-Z0-9 ]{0,100}-----/, "")
    .replace(/-----END [A-Z0-9 ]{0,100}-----$/, "")
    .replace(/\\[nr]/g, "");
  let n = 0;
  for (let i = 0; i < body.length && n < MIN_KEY_BODY_CHARS; i += 1) {
    const c = body.charCodeAt(i);
    const isB64 =
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47;
    if (isB64) n += 1;
  }
  return n >= MIN_KEY_BODY_CHARS;
}

/**
 * A whole value that is a named template slot, not a secret: `${DB_PASS}`,
 * `{{ .pw }}`, `{pw}`, `%(pw)s`, `$DB_PASS`, `<password>`, `****`. Only the
 * whole shape counts: a value that merely starts with `$`, `%` or `{`
 * (`$ecretPa55`, a percent-encoded password) is a value.
 */
const PLACEHOLDER_RE =
  /^(?:\$\{[^{}]{1,100}\}|\{\{[^{}]{1,100}\}\}|\{[A-Za-z_][\w.-]{0,100}\}|%\([\w.-]{1,100}\)s|\$[A-Z_][A-Z0-9_]{0,100}|<[^<>]{1,100}>|\*+)$/;

function isUrlCredential(match: string): boolean {
  return !PLACEHOLDER_RE.test(match.slice(match.indexOf(":") + 1));
}

/**
 * A value assigned to a password, token or key NAME is a secret unless it is
 * plainly not one: a template slot or an interpolation, `changeme`, `xxx`, one
 * repeated character (`********`), a path, URL or URN, another class's marker, or a bare
 * word or dotted name with no digit or symbol (`"refresh"`, `settings.SECRET_KEY`,
 * `your-api-key-here`, `true`): an enum value or a reference, not a literal.
 */
function isAssignedSecret(match: string): boolean {
  if (PLACEHOLDER_RE.test(match) || match.includes("[REDACTED:")) return false;
  // Interpolated (`${secret}-api-key`), so not a literal; or a stand-in.
  if (/\$\{|\{\{|change[_-]?me|xxx/i.test(match) || /^(.)\1*$/.test(match)) return false;
  // A word in any script (a translation: "Contraseña", "(Test-)Token") is a label.
  if (/^(?:[A-Za-z_.()-]|[^\x00-\x7F])+$/.test(match)) return false;
  if (/^(?:\.{0,2}\/|~\/|[A-Za-z]:\\|urn:|[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/)/i.test(match))
    return false;
  return !/\.(?:pem|key|crt|cer|der|p12|pfx|jks|json|ya?ml|txt)$/i.test(match);
}

// Digest lengths a hex string legitimately has: MD5, SHA-1, SHA-224, SHA-256,
// SHA-384, SHA-512. Any other length of 32+ hex characters is treated as key
// material, unless a "this is a hash" word stands just before it.
const HEX_HASH_LENGTHS = new Set([32, 40, 56, 64, 96, 128]);
const HEX_CONTEXT_PREFIX_RE = /(?:commit|sha-?\d*|git|hash|digest|md5|fingerprint)[\s:=]+$/i;

function isHexSecret(match: string, input: string, offset: number): boolean {
  if (HEX_HASH_LENGTHS.has(match.length)) return false;
  return !HEX_CONTEXT_PREFIX_RE.test(input.slice(Math.max(0, offset - 24), offset));
}

/** Slack's documented webhook placeholder: all-zero workspace and channel ids, an all-X (or all-zero) secret. */
const SLACK_WEBHOOK_PLACEHOLDER_RE = /\/services\/T0+\/B0+\/(?:X+|0+)$/i;

/**
 * The set, most specific first: a key block or a vendor key is replaced before
 * a generic shape (a long hex run, `Bearer …`) could take part of it.
 */
const SPECS: readonly PatternSpec[] = [
  {
    // PEM and OpenSSH private keys, multi-line or as one escaped string
    // (`"-----BEGIN PRIVATE KEY-----\nMIIE…\n-----END PRIVATE KEY-----\n"` in a
    // JSON service-account file). The body may not contain `-----`, so it stops
    // at the END line (or at the next BEGIN): one path through it, no backtracking.
    // Quotes are body so a key split into string literals (`"MIIE…\n" + "…"`) is
    // one block; PGP armor (`PRIVATE KEY BLOCK`) is the same shape.
    id: "private_key",
    kind: "private key",
    re: () =>
      /-----BEGIN (?:[A-Z0-9]{1,20} ){0,4}PRIVATE KEY(?: BLOCK)?-----(?:[A-Za-z0-9+/=\s:,"']|\\[nr]|-(?!----))*(?:-----END (?:[A-Z0-9]{1,20} ){0,4}PRIVATE KEY(?: BLOCK)?-----)?/g,
    highConfidence: true,
    accept: hasKeyBody,
  },
  {
    // `scheme://user:password@host` — the `user:password` part only, so the
    // scheme and host stay readable. The password may hold a raw `@`: it ends at
    // the last `@` that is followed by a host and then a delimiter.
    id: "url_credentials",
    kind: "credentials in a URL",
    re: () =>
      /(?<=\b[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/)[^\s:/@"'<>]{0,256}:[^\s/"'<>]{1,256}(?=@[^\s@/"'<>]{0,256}(?:[\s/:?#"'<>]|$))/g,
    highConfidence: false,
    accept: isUrlCredential,
  },
  {
    id: "aws_key",
    kind: "AWS access key id",
    re: () => /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    highConfidence: true,
  },
  {
    // Keyword-anchored: a bare 40-character base64 string is not a secret, the
    // value after `aws_secret_access_key` is.
    id: "aws_secret",
    kind: "AWS secret access key",
    re: () =>
      /(?<=aws_secret_access_key["']?[ \t]{0,8}[=:][ \t]{0,8}["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi,
    highConfidence: false,
  },
  {
    id: "github_pat",
    kind: "GitHub token",
    re: () => /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    highConfidence: true,
  },
  {
    id: "anthropic_key",
    kind: "Anthropic API key",
    re: () => /(?<![\w-])sk-ant-[A-Za-z0-9_-]{20,}/g,
    highConfidence: true,
  },
  {
    id: "openai_key",
    kind: "OpenAI API key",
    re: () => /(?<![\w-])sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g,
    highConfidence: true,
  },
  {
    id: "slack_token",
    kind: "Slack token",
    re: () => /(?<![\w-])xox[abposr]-[A-Za-z0-9-]{10,}/g,
    highConfidence: true,
  },
  {
    id: "slack_webhook",
    kind: "Slack webhook URL",
    re: () => /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/]{20,}/g,
    highConfidence: true,
    // Slack's own docs print `…/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX`,
    // so a definition that quotes that placeholder is not refused. Redacted all
    // the same, like every other match.
    refuse: (match) => !SLACK_WEBHOOK_PLACEHOLDER_RE.test(match),
  },
  {
    id: "google_api_key",
    kind: "Google API key",
    re: () => /\bAIza[0-9A-Za-z_-]{35}(?![\w-])/g,
    highConfidence: true,
  },
  {
    id: "stripe_key",
    kind: "Stripe key",
    re: () => /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{24,})\b/g,
    highConfidence: true,
    // Stripe publishes an `sk_test_` key in its own docs, so a definition that
    // quotes it is not refused. Redacted all the same: a test-mode key still
    // reads and writes its account's test data.
    refuse: (match) => !match.startsWith("sk_test_"),
  },
  {
    id: "npm_token",
    kind: "npm token",
    re: () => /\bnpm_[A-Za-z0-9]{36}\b/g,
    highConfidence: true,
  },
  {
    id: "gitlab_token",
    kind: "GitLab token",
    re: () => /(?<![\w-])glpat-[A-Za-z0-9_-]{20,}/g,
    highConfidence: true,
  },
  {
    id: "sendgrid_key",
    kind: "SendGrid API key",
    re: () => /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![\w-])/g,
    highConfidence: true,
  },
  {
    id: "huggingface_token",
    kind: "Hugging Face token",
    re: () => /\bhf_[A-Za-z0-9]{34,}\b/g,
    highConfidence: true,
  },
  {
    id: "pypi_token",
    kind: "PyPI token",
    re: () => /(?<![\w-])pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/g,
    highConfidence: true,
  },
  {
    id: "digitalocean_token",
    kind: "DigitalOcean token",
    re: () => /\bdo[por]_v1_[a-f0-9]{64}\b/g,
    highConfidence: true,
  },
  {
    // The value of `AccountKey=` in an Azure Storage connection string.
    id: "azure_storage_key",
    kind: "Azure Storage account key",
    re: () => /(?<=AccountKey=)[A-Za-z0-9+/]{86}==/g,
    highConfidence: true,
  },
  {
    id: "bearer",
    kind: "bearer token",
    re: () => /\bBearer\s+[A-Za-z0-9._\-/+=]{16,}/g,
    highConfidence: false,
  },
  {
    // Header and payload are base64url JSON, so both start `eyJ` (`{"`).
    id: "jwt",
    kind: "JSON Web Token",
    re: () => /(?<![\w-])eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}/g,
    highConfidence: false,
  },
  {
    id: "long_hex",
    kind: "hex-encoded secret",
    re: () => /\b[a-f0-9]{32,}\b/gi,
    highConfidence: false,
    accept: isHexSecret,
  },
  {
    // A literal assigned to a password, token or key NAME (`DB_PASSWORD=…`,
    // `"client_secret": "…"`, `api_key: …`, `token := "…"`): the value only, so
    // the name stays readable. Last, so a vendor shape names its own class
    // first. Two forms:
    //   - quoted, anywhere on a line (code, JSON, YAML, `.env`): the value ends
    //     at its closing quote;
    //   - unquoted, as a whole line's value (`.env`, YAML, `.properties`): the
    //     name starts the line and the value runs to its end or a `#`. Code
    //     (`token = cfg.token`, `password = get()`) has no such line.
    // Not high-confidence: a name says nothing about the value, so it is
    // redacted but never refuses a save. `isAssignedSecret` keeps placeholders,
    // references and bare words.
    id: "assigned_secret",
    kind: "secret assigned to a password, token or key name",
    re: () =>
      /(?<=(?:passw(?:or)?d|secret(?:[_-]?key)?|api[_-]?key|token|private[_-]?key)["']?[ \t]{0,8}(?::=|=>|[=:])[ \t]{0,8}["'`])[^\s"'`]{6,200}(?=["'`])|(?<=^[ \t]{0,40}(?:(?:export|-)[ \t]{1,8})?["']?[\w.-]{0,60}(?:passw(?:or)?d|secret(?:[_-]?key)?|api[_-]?key|token|private[_-]?key)["']?[ \t]{0,8}[=:][ \t]{0,8})[^\s"'`#;,\(\)\{\}[\]<>=*&!][^\s"'`#;,\(\)\{\}[\]<>]{5,199}(?=[ \t]{0,40}(?:#|\r?$))/gim,
    highConfidence: false,
    accept: isAssignedSecret,
  },
];

/** {@link SPECS}, frozen; each `re` read is a fresh RegExp (see {@link SecretPattern.re}). */
export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze(SPECS.map(secretPattern));

/**
 * Two classes keep the marker the connector redactor always gave them, so a
 * stored connector document does not change for nothing.
 */
const LEGACY_LABELS: Readonly<Record<string, string>> = {
  bearer: "token",
  long_hex: "secret",
};

/** The marker a redacted secret of class `id` is replaced with. */
export function secretMarker(id: string): string {
  return `[REDACTED:${LEGACY_LABELS[id] ?? id}]`;
}

/**
 * `match` with every line's text replaced by `marker` and every line break
 * kept, so the text around it keeps its line numbers.
 */
function inPlace(match: string, marker: string): string {
  return match.replace(/[^\r\n]+/g, marker);
}

/** Every match of `p` in `text` that its `accept` keeps, in order. */
export function* secretMatches(p: SecretPattern, text: string): Generator<string> {
  for (const m of text.matchAll(p.re)) {
    if (!p.accept || p.accept(m[0], text, m.index)) yield m[0];
  }
}

export interface SecretRedaction {
  /** The input with every secret replaced in place; same line count, same line numbers. */
  text: string;
  /** How many secrets were replaced. */
  count: number;
  /** How many of each class (`SecretPattern.id`); never a matched value. */
  byClass: Record<string, number>;
}

/**
 * {@link SecretRedaction.byClass} as `{ class, count }` entries, for a log line.
 * The logger blanks any meta KEY that names a secret (`/secret/`, `/token/`,
 * `/private[-_]?key/`, `/credential/`), so a class id used as a key
 * (`assigned_secret`, `slack_token`) would log as `[REDACTED]`, not a number.
 */
export function secretClassCounts(
  byClass: Readonly<Record<string, number>>,
): Array<{ class: string; count: number }> {
  return Object.entries(byClass).map(([id, count]) => ({ class: id, count }));
}

/**
 * Replace every secret in `input` with a marker naming its class. The one
 * function every write and read path over repository text calls.
 *
 * `skip` names classes to leave alone; only the connector redactor passes it
 * (`PII_REDACT_DISABLE_PATTERNS`).
 */
export function redactSecrets(
  input: string,
  options: { skip?: ReadonlySet<string> } = {},
): SecretRedaction {
  const byClass: Record<string, number> = {};
  let count = 0;
  if (!input) return { text: input, count, byClass };
  let text = input;
  for (const p of SECRET_PATTERNS) {
    if (options.skip?.has(p.id)) continue;
    const marker = secretMarker(p.id);
    text = text.replace(p.re, (match: string, offset: number, whole: string) => {
      if (p.accept && !p.accept(match, whole, offset)) return match;
      count += 1;
      byClass[p.id] = (byClass[p.id] ?? 0) + 1;
      return inPlace(match, marker);
    });
  }
  return { text, count, byClass };
}
