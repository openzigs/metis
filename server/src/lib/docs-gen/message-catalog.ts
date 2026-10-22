/**
 * #1403 — user-facing message text for the translation keys a module's code
 * shows.
 *
 * Code that is translated names its messages by key
 * (`locale.NewLocalizedError("error.bad_credentials")`), and the text a user
 * sees lives in the repository's locale file ("Invalid username or password.").
 * Phase 1 reads the code, so the facts carry the key, and the writer quoted it
 * written out as words ("bad credentials") as though it were on screen.
 *
 * So, deterministically and with no model call:
 *
 *   1. {@link loadMessageCatalog} finds the repository's English locale file(s)
 *      by common i18n layouts (`translations/en_US.json`, `locales/en.json`,
 *      `config/locales/en.yml`, `messages.properties`, …) — nothing here names
 *      a product — and flattens them to `key → text`.
 *   2. {@link findMessageKeys} lists the keys a module's source uses: a string
 *      literal that is a key of the catalogue (resolved), or a key-shaped
 *      literal passed to a translation call that the catalogue does not have
 *      (unresolved).
 *   3. {@link renderMessageBlock} gives the writer the resolved text to quote,
 *      and for an unresolved key tells it to describe the message, not quote it.
 *
 * Locale text is repository content and reaches the prompts, so it is treated
 * as untrusted: bounded (files, bytes, keys, characters per message), flattened
 * to one line, and passed through the writer and section fence scrubs.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import {
  scrubSectionFenceLookalikes,
  scrubWriterFenceLookalikes,
} from "../ai/tool-runtime/fence-scrub.js";
import { resolveSourcePath } from "./repository-sources.js";

/** A repository's English messages, `key → text`, and the file(s) they came from. */
export interface MessageCatalog {
  /** Repository-relative paths of the locale files read, most preferred first. */
  files: string[];
  messages: ReadonlyMap<string, string>;
}

/** One message a module's code shows by key. `text` is null when no locale file has it. */
export interface MessageKeyRef {
  key: string;
  text: string | null;
}

/** Directory names that hold translations in common i18n layouts. */
const LOCALE_DIRS = new Set([
  "locale",
  "locales",
  "translations",
  "translation",
  "i18n",
  "l10n",
  "lang",
  "langs",
  "languages",
  "messages",
  "intl",
]);

/** English locale names, most preferred first (`en_US` before `en_GB`). */
const ENGLISH = ["en_us", "en-us", "en", "en_gb", "en-gb", "english"];

const LOCALE_EXTENSIONS = new Set([".json", ".yml", ".yaml", ".properties"]);

/** Directories never searched for locale files. */
const SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "third_party",
  "dist",
  "build",
  "target",
  ".next",
  "coverage",
  "__pycache__",
  ".venv",
]);

/** How deep, and how many directory entries, the search reads. */
export const LOCALE_SEARCH_MAX_DEPTH = 7;
export const LOCALE_SEARCH_MAX_ENTRIES = 20_000;
/** At most this many locale files are read, each at most this many bytes. */
export const LOCALE_MAX_FILES = 8;
export const LOCALE_FILE_MAX_BYTES = 1_000_000;
/** At most this many keys are kept from all files together. */
export const LOCALE_MAX_KEYS = 20_000;
/** A message is cut to this many characters. */
export const MESSAGE_TEXT_MAX_CHARS = 200;
/** At most this many messages are listed for one module. */
export const MODULE_MESSAGES_MAX = 30;

/** A key we accept from a locale file or the code: no spaces, quotes or fence characters. */
const KEY = /^[A-Za-z0-9_][\w.:-]{0,119}$/;
/** A literal that reads as a message key on its own: dotted (`error.bad_credentials`). */
const KEY_SHAPED = /^[A-Za-z][\w-]*(?:\.[\w-]+)+$/;

/**
 * The rank of a repository-relative path as an English locale file (lower is
 * preferred), or null when it is not one. Matches:
 *  - `<locale dir>/…/en_US.json` (and `en.json`, `en.yml`, `en-GB.yaml`, …);
 *  - `<locale dir>/…/en/<namespace>.json` (i18next's `locales/en/common.json`);
 *  - `messages.properties` / `messages_en.properties` (Java resource bundles).
 */
export function localeFileRank(relativePath: string): number | null {
  const parts = relativePath.split("/");
  const file = parts.at(-1) ?? "";
  const ext = path.extname(file).toLowerCase();
  if (!LOCALE_EXTENSIONS.has(ext)) return null;
  const base = file.slice(0, -ext.length).toLowerCase();
  if (ext === ".properties") {
    if (base === "messages_en_us" || base === "messages_en") return 0;
    return base === "messages" ? 1 : null;
  }
  const dirs = parts.slice(0, -1).map((d) => d.toLowerCase());
  if (!dirs.some((d) => LOCALE_DIRS.has(d))) return null;
  const own = ENGLISH.indexOf(base);
  if (own >= 0) return own;
  const parent = ENGLISH.indexOf(dirs.at(-1) ?? "");
  return parent >= 0 ? ENGLISH.length + parent : null;
}

/** One message as it may be shown to a model: one line, bounded, fence look-alikes scrubbed. */
export function sanitizeMessageText(raw: string): string {
  // Control characters, line breaks and tabs become spaces so a message can
  // never open a line of its own (a heading, a fence, an instruction).
  const flat = raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ");
  const scrubbed = scrubSectionFenceLookalikes(
    scrubWriterFenceLookalikes(flat.trim(), "[REDACTED-FENCE]"),
    "[REDACTED-FENCE]",
  );
  return scrubbed.length > MESSAGE_TEXT_MAX_CHARS
    ? `${scrubbed.slice(0, MESSAGE_TEXT_MAX_CHARS - 1).trimEnd()}…`
    : scrubbed;
}

/** The first string of a leaf: a string, or the first string of a plural-forms array. */
function leafText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.find((v): v is string => typeof v === "string") ?? null;
  return null;
}

/** Most nodes one file's walk visits (a YAML alias can repeat a subtree). */
const FLATTEN_MAX_NODES = 200_000;

function flatten(
  value: unknown,
  prefix: string,
  out: Map<string, string>,
  budget = { nodes: FLATTEN_MAX_NODES },
): void {
  if (out.size >= LOCALE_MAX_KEYS || --budget.nodes < 0) return;
  const text = leafText(value);
  if (text !== null) {
    if (prefix && KEY.test(prefix) && !out.has(prefix)) {
      const clean = sanitizeMessageText(text);
      if (clean) out.set(prefix, clean);
    }
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out, budget);
    if (out.size >= LOCALE_MAX_KEYS || budget.nodes < 0) return;
  }
}

function parseProperties(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = content.replace(/\\\r?\n\s*/g, "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const match = /^([^=:\s]+)\s*[=:\s]\s*(.*)$/.exec(trimmed);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

/**
 * The messages of one locale file, `key → text`. Nested objects flatten to
 * dotted keys; a Rails-style file whose only top-level key is the locale
 * (`en:`) is read from inside it. A file that does not parse yields nothing.
 */
export function parseLocaleFile(relativePath: string, content: string): Map<string, string> {
  const out = new Map<string, string>();
  const ext = path.extname(relativePath).toLowerCase();
  let parsed: unknown;
  try {
    if (ext === ".json") parsed = JSON.parse(content);
    else if (ext === ".properties") parsed = parseProperties(content);
    else parsed = yaml.load(content, { schema: yaml.JSON_SCHEMA });
  } catch {
    return out;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const keys = Object.keys(parsed);
    if (keys.length === 1 && ENGLISH.includes(keys[0].toLowerCase())) {
      parsed = (parsed as Record<string, unknown>)[keys[0]];
    }
  }
  flatten(parsed, "", out);
  return out;
}

/** Repository-relative paths of English locale files under `root`, most preferred first. */
export async function findLocaleFiles(root: string): Promise<string[]> {
  const found: Array<{ rel: string; rank: number }> = [];
  let entries = 0;
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > LOCALE_SEARCH_MAX_DEPTH || entries >= LOCALE_SEARCH_MAX_ENTRIES) return;
    let listing;
    try {
      listing = await readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    listing.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of listing) {
      if (++entries > LOCALE_SEARCH_MAX_ENTRIES) return;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      // Symbolic links are not followed: a locale file is read only where it is.
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          await walk(child, depth + 1);
        }
      } else if (entry.isFile()) {
        const rank = localeFileRank(child);
        if (rank !== null) found.push({ rel: child, rank });
      }
    }
  };
  await walk("", 0);
  return found
    .sort((a, b) => a.rank - b.rank || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel))
    .slice(0, LOCALE_MAX_FILES)
    .map((f) => f.rel);
}

/**
 * The repository's English messages, or null when it has no locale file this
 * recognises (or none could be read). A key in a more preferred file wins.
 */
export async function loadMessageCatalog(root: string | null): Promise<MessageCatalog | null> {
  if (!root) return null;
  const files: string[] = [];
  const messages = new Map<string, string>();
  for (const rel of await findLocaleFiles(root)) {
    try {
      const resolved = await resolveSourcePath(root, rel);
      if ((await lstat(resolved)).size > LOCALE_FILE_MAX_BYTES) continue;
      const parsed = parseLocaleFile(rel, await readFile(resolved, "utf-8"));
      if (parsed.size === 0) continue;
      files.push(rel);
      for (const [key, text] of parsed) {
        if (messages.size >= LOCALE_MAX_KEYS) break;
        if (!messages.has(key)) messages.set(key, text);
      }
    } catch {
      // An unreadable or escaping locale file is skipped, never fatal.
    }
  }
  return files.length > 0 ? { files, messages } : null;
}

/** Any quoted literal. */
const LITERAL = /(["'`])([^"'`\s\\]{2,120})\1/g;
/**
 * A call whose (first or second) argument is a quoted literal: the callee and
 * the literal. Only a translation-like callee makes a literal an unresolved key.
 */
const CALL_LITERAL =
  /([A-Za-z_$][\w$]*)\s*\(\s*(?:[A-Za-z_$][\w$.]*\s*,\s*)?(["'`])([^"'`\s\\]{2,120})\2/g;
const TRANSLATION_CALLEE =
  /^(?:t|tr|_t|\$t|_{1,2}|l|i18n\w*|translat\w*|\w*gettext|print\w*|sprintf|\w*locali[sz]\w*|\w*message|getstring)$/i;

/**
 * The message keys `sources` (a module's code) use, in first-use order:
 *  - a literal that is a key of `catalog`, with its text, when the key reads
 *    as one (it has a `.`, `_` or `:`; a bare word such as `"name"` is not
 *    taken for a message);
 *  - a dotted literal passed to a translation-like call (`t(…)`, `Print(…)`,
 *    `NewLocalizedError(…)`, `gettext(…)`, …) that `catalog` lacks, with no text.
 */
export function findMessageKeys(
  sources: Iterable<string>,
  catalog: MessageCatalog | null,
): MessageKeyRef[] {
  const refs = new Map<string, MessageKeyRef>();
  for (const text of sources) {
    if (catalog) {
      for (const match of text.matchAll(LITERAL)) {
        const key = match[2];
        if (refs.has(key) || !/[._:]/.test(key)) continue;
        const resolved = catalog.messages.get(key);
        if (resolved !== undefined) refs.set(key, { key, text: resolved });
      }
    }
    for (const match of text.matchAll(CALL_LITERAL)) {
      const key = match[3];
      if (refs.has(key) || !TRANSLATION_CALLEE.test(match[1])) continue;
      if (!KEY_SHAPED.test(key) || !KEY.test(key)) continue;
      refs.set(key, { key, text: catalog?.messages.get(key) ?? null });
    }
  }
  return [...refs.values()];
}

/** The heading of a module's message block. */
export const MESSAGE_BLOCK_HEADING = "USER-FACING MESSAGES";

/**
 * The block a section's writer reads for one module: each key with the text
 * the user sees, to quote exactly, or — for a key no locale file has — an
 * instruction to describe the message instead of quoting it. Empty when the
 * module shows no message by key. At most {@link MODULE_MESSAGES_MAX} entries,
 * resolved ones first.
 */
export function renderMessageBlock(refs: readonly MessageKeyRef[]): string {
  if (refs.length === 0) return "";
  const ordered = [...refs.filter((r) => r.text !== null), ...refs.filter((r) => r.text === null)];
  const listed = ordered.slice(0, MODULE_MESSAGES_MAX);
  const lines = listed.map((r) =>
    r.text !== null
      ? `- \`${r.key}\` → ${JSON.stringify(r.text)}`
      : `- \`${r.key}\` → (no text found in the repository: describe what this message tells the user; do not quote it)`,
  );
  const more = refs.length - listed.length;
  return [
    `${MESSAGE_BLOCK_HEADING}`,
    'This code shows messages by translation key. The facts may name one by its key or by the key written out as words (`error.bad_credentials` as "bad credentials"). Neither is what the user sees: quote a message only as the text given here, and never quote a key.',
    ...lines,
    ...(more > 0 ? [`- (${more} more messages not listed: describe them, do not quote them)`] : []),
  ].join("\n");
}
