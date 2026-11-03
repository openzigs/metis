/**
 * Epic #1608 (#1624) — the post-check on the model's report prose: it may not
 * introduce a product, repo or file the assessment does not contain.
 *
 * The prose is split into sentences, and every sentence that names something
 * entity-shaped the assessment does not know is dropped whole (a sentence
 * about a hallucinated repo is wrong as a whole, not just in its noun). What
 * counts as entity-shaped:
 *
 * - a path or `owner/repo` (a token with a `/` and a `.`, `-`, `_` or digit in
 *   it, or two or more `/`);
 * - a file name (a token ending in a source or config extension);
 * - a code identifier (`kebab-case` with a digit or a component suffix such as
 *   `-api`, `snake_case`, `CamelCase`), or anything the model put in backticks;
 * - a name before a component noun ("the Payments product", "the ledger-core
 *   repo"), less any leading stopword.
 *
 * Allowed: the names the caller supplies (the products the run could read) and
 * every entity-shaped token of the requirement statement itself. Everything is
 * scanned by hand or with anchored per-token patterns, never a regex over the
 * whole text, so the check is linear in the prose (#1647).
 */

/** Source and config extensions a file name ends in. */
const FILE_EXTENSIONS = new Set(
  (
    "ts tsx js jsx mjs cjs py go java kt rb rs cs php sql graphql gql proto yaml yml json " +
    "md xml html css scss sh tf swift scala c h cpp hpp vue svelte toml ini cfg env lock"
  ).split(" "),
);

/** The last segment of a kebab-case component name. */
const COMPONENT_SUFFIXES = new Set(
  (
    "api apis svc service services web app ui core gateway worker workers lib libs sdk " +
    "server client backend frontend db store adapter connector bot cli portal"
  ).split(" "),
);

/** Nouns that make the words before them a component name. */
const COMPONENT_NOUNS = new Set(
  (
    "product products service services system systems repo repos repository repositories " +
    "app apps application applications platform platforms module modules library libraries " +
    "package packages microservice microservices team teams"
  ).split(" "),
);

/** Leading words that are not part of a name ("The Orders product"). */
const STOPWORDS = new Set(
  (
    "the a an this that these those each every both its their our your any all no one two " +
    "three another other some several many most such same its which whose either neither " +
    "restricted affected downstream upstream direct directly shared consuming providing " +
    "existing current new main core related dependent and or of for to in on with by"
  ).split(" "),
);

const TRIM = new Set([..."\"'()[]{}<>,;:!?*`“”‘’"]);

/** A token with the punctuation around it removed (a trailing `.` included). */
function bare(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && TRIM.has(token[start])) start += 1;
  while (end > start && (TRIM.has(token[end - 1]) || token[end - 1] === ".")) end -= 1;
  return token.slice(start, end);
}

function isCapitalized(word: string): boolean {
  return word.length > 0 && word[0] >= "A" && word[0] <= "Z";
}

/** Whether a bare token is shaped like a path, file or code identifier. */
export function isEntityShaped(token: string): boolean {
  if (token.length < 2) return false;
  // Nothing a person writes in prose is one 200-character word.
  if (token.length > 200) return true;
  if (token.includes("/")) {
    const slashes = token.split("/").length - 1;
    return slashes >= 2 || /[.\-_\d]/.test(token);
  }
  const dot = token.lastIndexOf(".");
  if (dot > 0 && FILE_EXTENSIONS.has(token.slice(dot + 1).toLowerCase())) return true;
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i.test(token)) {
    if (token.includes("_")) return true;
    const parts = token.toLowerCase().split("-");
    return parts.some((p) => /\d/.test(p)) || COMPONENT_SUFFIXES.has(parts[parts.length - 1]);
  }
  // CamelCase with an inner capital: `PaymentsGateway`, `ordersApi`.
  return /^[A-Za-z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$/.test(token);
}

/** Split prose into sentences: a `.`, `!` or `?` followed by whitespace (or the end) ends one. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (
      (c === "." || c === "!" || c === "?") &&
      (i + 1 === text.length || /\s/.test(text[i + 1]))
    ) {
      const s = text.slice(start, i + 1).trim();
      if (s) out.push(s);
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** Every entity-shaped candidate a sentence names. */
export function entityCandidates(sentence: string): string[] {
  const out: string[] = [];
  // Anything the model put in backticks is code-shaped by its own say-so.
  const ticks = sentence.split("`");
  for (let i = 1; i < ticks.length; i += 2) {
    const span = ticks[i].trim();
    if (span) out.push(span);
  }
  const tokens = sentence.split(/\s+/).filter(Boolean);
  const words = tokens.map(bare);
  words.forEach((w, i) => {
    if (isEntityShaped(w)) out.push(w);
    if (!COMPONENT_NOUNS.has(w.toLowerCase()) || i === 0) return;
    // The name before the noun: the capitalized or identifier-shaped words just before it.
    const name: string[] = [];
    for (let j = i - 1; j >= 0 && name.length < 4; j -= 1) {
      const prev = words[j];
      // The word right before the noun counts in lowercase too ("the refunder repo").
      const lowerName = j === i - 1 && /^[a-z]+$/.test(prev) && !STOPWORDS.has(prev);
      if (!prev || !(isCapitalized(prev) || isEntityShaped(prev) || lowerName)) break;
      // A sentence-final `.` or `,` on the word before ends the name there.
      if (/[.,;:]$/.test(tokens[j])) break;
      name.unshift(prev);
    }
    while (name.length > 0 && STOPWORDS.has(name[0].toLowerCase())) name.shift();
    if (name.length > 0) out.push(name.join(" "));
  });
  return out;
}

/** What prose may name. */
export interface EntityAllowList {
  /** Product id -> name, for every product the prose may name. */
  products: ReadonlyMap<string, string>;
  /** Any other text the prose may name (the requirement statement, its criteria). */
  texts?: readonly string[];
}

export interface CheckedProse {
  text: string;
  /** Sentences dropped for naming something the assessment does not contain. */
  stripped: number;
  /** The ids of the products the kept text names. */
  mentions: string[];
}

/** An allow-list, indexed for case-insensitive lookups. */
export class EntityIndex {
  private readonly allowed = new Set<string>();
  private readonly productNames: Array<[string, string]>;
  /** #1732 — each lowercased product name and the ids that carry it, longest first. */
  private readonly namesLongestFirst: Array<[string, string[]]>;

  constructor(list: EntityAllowList) {
    this.productNames = [...list.products].map(([id, name]) => [id, name.toLowerCase()]);
    const byName = new Map<string, string[]>();
    for (const [id, name] of this.productNames) {
      // An empty name names nothing (and would never advance the scan below).
      if (name) byName.set(name, [...(byName.get(name) ?? []), id]);
    }
    this.namesLongestFirst = [...byName].sort(([a], [b]) => b.length - a.length);
    for (const [, name] of this.productNames) this.allowed.add(name);
    for (const text of list.texts ?? []) {
      for (const s of sentences(text)) {
        for (const c of entityCandidates(s)) this.allowed.add(c.toLowerCase());
      }
      for (const token of text.split(/\s+/)) {
        const b = bare(token);
        if (b) this.allowed.add(b.toLowerCase());
      }
    }
  }

  allows(candidate: string): boolean {
    return this.allowed.has(candidate.toLowerCase());
  }

  /**
   * The products a sentence names, as whole words. #1732 — the longest name
   * claims its span first, so "Orders" is not found again inside "Orders v3":
   * a reader who may read "Orders v3" but not another workspace's "Orders"
   * would otherwise lose a paragraph that never named it. Products that share
   * one name are all named by it.
   */
  mentionsIn(sentence: string): string[] {
    const lower = sentence.toLowerCase();
    const word = (c: string | undefined) => c !== undefined && /[a-z0-9]/.test(c);
    const claimed = new Uint8Array(lower.length);
    const named = new Set<string>();
    for (const [name, ids] of this.namesLongestFirst) {
      for (let at = lower.indexOf(name); at !== -1; at = lower.indexOf(name, at + 1)) {
        const end = at + name.length;
        if (word(lower[at - 1]) || word(lower[end])) continue;
        if (claimed.subarray(at, end).some((c) => c === 1)) continue;
        claimed.fill(1, at, end);
        for (const id of ids) named.add(id);
      }
    }
    return this.productNames.filter(([id]) => named.has(id)).map(([id]) => id);
  }
}

/** Drop every sentence of `text` that names an entity `index` does not allow. */
export function checkProse(text: string, index: EntityIndex): CheckedProse {
  const kept: string[] = [];
  let stripped = 0;
  const mentions = new Set<string>();
  for (const s of sentences(text)) {
    if (entityCandidates(s).every((c) => index.allows(c))) {
      kept.push(s);
      for (const id of index.mentionsIn(s)) mentions.add(id);
    } else {
      stripped += 1;
    }
  }
  return { text: kept.join(" "), stripped, mentions: [...mentions].sort() };
}

/**
 * Model prose made inert for Markdown, as `sanitizePanelText` does for the
 * published confidence note (OWASP LLM02): backticks and angle brackets go (no
 * code span, fence or HTML tag can open), and so do the brackets of a link;
 * whitespace collapses, so the prose stays inside the paragraph it is put in.
 */
export function sanitizeProse(text: string, max: number): string {
  return (
    text
      .replace(/[`<>[\]]/g, " ")
      // GFM autolinks a `www.` host: break it so no clickable link is exported.
      .replace(/www\./gi, "www ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max)
      .trim()
  );
}
