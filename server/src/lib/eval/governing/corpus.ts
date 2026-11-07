/**
 * #1867 — the held-out governing-rules corpus: a synthetic policy of atomic
 * obligations, analyst-worded requirements, and the ground truth of which rules
 * truly apply to each, with a per-rule verdict.
 *
 * Every model-facing issue of epic #1866 is judged on this set, so its shape is
 * checked here before anything is measured ({@link validateGoverningCorpus}):
 *
 *   - every file of the corpus directory is listed in the manifest, and the
 *     policy carries no AICPA Trust Services Criteria marker (#1867: the TSC
 *     text is copyrighted; the policy is written for the fixture);
 *   - no text an arm's prompt carries (the policy, its title, the rule
 *     summaries, the requirements) has a word telling a model it is reading
 *     an evaluation ({@link evaluationLeaks}, #1900);
 *   - each rule of the manifest has exactly one clause in every revision of the
 *     policy, and a later revision changes exactly the clauses it says it does;
 *   - a requirement reads as an analyst wrote it: no rule id, and no run of
 *     {@link CLAUSE_PHRASE_WORDS} words copied from any clause;
 *   - a pair labelled `nonResembling` really shares no vocabulary with its
 *     rule ({@link sharedVocabulary}), so the subset measures what it says: a
 *     rule that applies without resembling the requirement;
 *   - the pass thresholds were recorded before any arm ran, and any later
 *     change to them carries the issue and the reason
 *     ({@link expectedThresholds}).
 *
 * The loader is pure over the committed files: no network, no database.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The registered corpora (`eval-data/corpus/<name>`). */
export const GOVERNING_CORPORA = ["governing-01-sample-policy"] as const;
export type GoverningCorpusName = (typeof GOVERNING_CORPORA)[number];

/** What a (requirement, rule) pair is judged to be. */
export const GOVERNING_VERDICTS = ["compliant", "gap", "needs-ba-input"] as const;
export type GoverningVerdict = (typeof GOVERNING_VERDICTS)[number];

/** A rule id: two capitals, a hyphen, two digits (`AC-01`). */
export const RULE_ID_SHAPE = /\b[A-Z]{2}-\d{2}\b/g;

/** A requirement may not copy this many consecutive words from a clause. */
export const CLAUSE_PHRASE_WORDS = 5;

/** The corpus minimums #1867 sets. */
export const MIN_NON_RESEMBLING_ITEMS = 8;
export const MIN_NEGATIVE_ITEMS = 5;

/** One atomic obligation, as the manifest records it (the clause lives in the policy). */
export interface GoverningRuleSpec {
  id: string;
  area: string;
  /** The one-line summary an extraction would produce: what the screen and A1 read. */
  summary: string;
}

/** One ground-truth pair: a rule that truly applies to the requirement. */
export interface TruthPair {
  ruleId: string;
  verdict: GoverningVerdict;
  /** The business fact a BA would have to supply; required for `needs-ba-input` only. */
  businessFact?: string;
  /** The rule applies though the requirement shares no vocabulary with it. */
  nonResembling?: boolean;
}

/** One analyst-worded requirement. An empty `applies` is a negative item. */
export interface GoverningItem {
  id: string;
  title: string;
  text: string;
  applies: TruthPair[];
}

export interface PolicyRevision {
  revision: string;
  /** Relative to the corpus directory. */
  file: string;
  effective: string;
  /** The rules whose clause this revision changes against the previous one. */
  changedRules: string[];
}

/** The numeric pass bars. */
export interface ThresholdValues {
  overallRecall: number;
  nonResemblingRecall: number;
  precision: number;
  citationAccuracy: number;
  maxNoEvidenceCompliantErrors: number;
}

/** A recorded change to the bars: later issues may not edit them silently. */
export interface ThresholdChange {
  issue: string;
  at: string;
  reason: string;
  set: Partial<ThresholdValues>;
}

export interface PassThresholds extends ThresholdValues {
  status: "proposed" | "adopted";
  proposedIn: string;
  proposedAt: string;
  recordedBeforeAnyArmRan: boolean;
  changes: ThresholdChange[];
}

export interface GoverningAnnotation {
  labelledBy: string;
  labelledAt: string;
  groundTruthFixedBeforeAnyArmRan: boolean;
  procedure: string;
  reviewedBy: string | null;
}

export interface GoverningCorpusManifest {
  id: GoverningCorpusName;
  description: string;
  purpose: "held-out";
  license: string;
  synthetic: true;
  /** Every file of the corpus directory except `manifest.json`. */
  files: string[];
  policy: { title: string; scored: string; revisions: PolicyRevision[] };
  annotation: GoverningAnnotation;
  thresholds: PassThresholds;
  rules: GoverningRuleSpec[];
  items: GoverningItem[];
}

/** A rule with its clause, read from the scored revision of the policy. */
export interface GoverningRule extends GoverningRuleSpec {
  clause: string;
}

/** A corpus, loaded and checked. */
export interface GoverningCorpus {
  name: GoverningCorpusName;
  dir: string;
  manifest: GoverningCorpusManifest;
  /** The scored revision's policy text, as stored: the source every citation is checked against. */
  policyFile: string;
  policyText: string;
  rules: GoverningRule[];
  ruleById: ReadonlyMap<string, GoverningRule>;
}

/** The bars as #1867 first proposed them; every later value derives from these plus `changes`. */
export const PROPOSED_THRESHOLDS: Readonly<ThresholdValues> = Object.freeze({
  overallRecall: 0.9,
  nonResemblingRecall: 0.85,
  precision: 0.6,
  citationAccuracy: 0.95,
  maxNoEvidenceCompliantErrors: 0,
});

/** The values the manifest must hold: the proposal with each recorded change applied in order. */
export function expectedThresholds(changes: readonly ThresholdChange[]): ThresholdValues {
  return changes.reduce<ThresholdValues>((acc, c) => ({ ...acc, ...c.set }), {
    ...PROPOSED_THRESHOLDS,
  });
}

const CLAUSE_LINE = /^\*\*([A-Z]{2}-\d{2})\*\*\s+(.+?)\s*$/;

/**
 * The clauses of a policy file: each `**XX-00** text` line is one rule, and the
 * text after the bold id is its clause. Ids seen twice are returned, not
 * silently overwritten.
 */
export function parsePolicyClauses(markdown: string): {
  clauses: Map<string, string>;
  duplicates: string[];
} {
  const clauses = new Map<string, string>();
  const duplicates: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = CLAUSE_LINE.exec(line);
    if (!m) continue;
    if (clauses.has(m[1]!)) duplicates.push(m[1]!);
    else clauses.set(m[1]!, m[2]!);
  }
  return { clauses, duplicates };
}

/**
 * Markers of the AICPA Trust Services Criteria: a criterion id (`CC6.1`,
 * `PI1.2`, `A1.2`, `C1.1`, `P4.3`) or the criteria's recurring phrase "the
 * entity's objectives". The TSC is copyrighted; the policy must carry neither.
 */
export function trustServicesCriteriaMarkers(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\b(?:CC|PI|A|C|P)\d\.\d+\b/g)) found.add(m[0]);
  for (const m of text.matchAll(/\bentity['’]s objectives\b/gi)) found.add(m[0]);
  return [...found].sort();
}

/**
 * Words that tell a model reading the policy it is being evaluated ("fixture",
 * "synthetic", an issue number). The policy reaches the arms' prompts, so it
 * must read as a company's own document; the provenance lives in ANNOTATION.md.
 */
export function evaluationLeaks(text: string): string[] {
  const found = new Set<string>();
  const re = /\b(?:fixtures?|synthetic|evaluations?|evals?|ground truth|METIS)\b|#\d{3,}/gi;
  for (const m of text.matchAll(re)) found.add(m[0]);
  return [...found].sort();
}

/** Words that carry no subject matter: they never count as shared vocabulary. */
const STOP_WORDS = new Set(
  (
    "a about above after again all also an and any are as at be because been before being " +
    "below between both but by can could did do does doing down during each either else " +
    "every for from further had has have having he her here hers him his how if in into is " +
    "it its itself just may me might more most must my no nor not now of off on once one " +
    "only or other our ours out over own same shall she should so some such than that the " +
    "their theirs them then there these they this those through to too under until up upon " +
    "us very was we were what when where whether which while who whom whose why will with " +
    "within without would yet you your"
  ).split(" "),
);

/**
 * #1900 — subject words shorter than four letters that still carry subject
 * matter: without them `log`, `tax`, `pii` and `vat` would never count as
 * shared vocabulary. A plural (`logs`, `taxes`) meets its singular.
 */
export const SHORT_SUBJECT_WORDS: ReadonlySet<string> = new Set([
  "api",
  "gps",
  "key",
  "log",
  "mfa",
  "pay",
  "pii",
  "sms",
  "sso",
  "ssn",
  "tax",
  "vat",
  "vpn",
]);

/** A short subject word `raw` is, or is the plural of; undefined when none. */
function shortSubjectWord(raw: string): string | undefined {
  for (const base of [raw, raw.replace(/e?s$/, "")]) {
    if (SHORT_SUBJECT_WORDS.has(base)) return base;
  }
  return undefined;
}

/**
 * The subject-matter stems of a text: lower-cased words of four letters or
 * more that are not stop words, each cut to its first five letters, so
 * `records` meets `recorded` and `finance` meets `financial`; plus every
 * {@link SHORT_SUBJECT_WORDS} word, plural or not. Deliberately eager to
 * match: a `nonResembling` label must survive the strictest reading.
 */
export function contentStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    const short = shortSubjectWord(raw);
    if (short !== undefined) out.add(short);
    if (raw.length < 4 || STOP_WORDS.has(raw)) continue;
    out.add(raw.slice(0, 5));
  }
  return out;
}

/** The stems two texts share, sorted. Empty means they share no vocabulary. */
export function sharedVocabulary(a: string, b: string): string[] {
  const right = contentStems(b);
  return [...contentStems(a)].filter((s) => right.has(s)).sort();
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/** Runs of `n` consecutive words that `text` copies from `source`. */
export function sharedPhrases(text: string, source: string, n = CLAUSE_PHRASE_WORDS): string[] {
  const grams = (ws: string[]) => {
    const out = new Set<string>();
    for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(" "));
    return out;
  };
  const inSource = grams(words(source));
  return [...grams(words(text))].filter((g) => inSource.has(g)).sort();
}

/** The rule ids a text names (`AC-01`), in order of appearance, without repeats. */
export function ruleIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(RULE_ID_SHAPE)].map((m) => m[0]))];
}

/** What {@link validateGoverningCorpus} reads besides the manifest. */
export interface CorpusFiles {
  /** Every file of the corpus directory, relative, `/`-separated. */
  present: readonly string[];
  /** The text of each policy revision's file, by revision. */
  policies: ReadonlyMap<string, string>;
}

function validateFiles(m: GoverningCorpusManifest, files: CorpusFiles, problems: string[]): void {
  const listed = new Set(m.files);
  for (const f of files.present) {
    if (f !== "manifest.json" && !listed.has(f)) {
      problems.push(`${f} is in the corpus directory but not listed in the manifest's files`);
    }
  }
  const present = new Set(files.present);
  for (const f of m.files) {
    if (!present.has(f)) problems.push(`the manifest lists ${f}, which does not exist`);
  }
}

function validatePolicy(m: GoverningCorpusManifest, files: CorpusFiles, problems: string[]): void {
  const ruleIds = m.rules.map((r) => r.id);
  const seen = new Set<string>();
  for (const r of m.rules) {
    if (seen.has(r.id)) problems.push(`rule ${r.id}: duplicate id`);
    seen.add(r.id);
    if (ruleIdsIn(r.id).join() !== r.id) problems.push(`rule ${r.id}: not an XX-00 id`);
    if (!r.summary.trim()) problems.push(`rule ${r.id}: empty summary`);
  }
  const revisions = m.policy.revisions;
  if (!revisions.some((r) => r.revision === m.policy.scored)) {
    problems.push(`the scored revision ${m.policy.scored} is not one of the policy's revisions`);
  }
  let previous: Map<string, string> | null = null;
  for (const rev of revisions) {
    const where = `policy ${rev.revision} (${rev.file})`;
    if (!m.files.includes(rev.file)) problems.push(`${where}: not listed in the manifest's files`);
    const text = files.policies.get(rev.revision);
    if (text === undefined) {
      problems.push(`${where}: not read`);
      continue;
    }
    const markers = trustServicesCriteriaMarkers(text);
    if (markers.length > 0) {
      problems.push(`${where}: carries Trust Services Criteria markers (${markers.join(", ")})`);
    }
    const leaks = evaluationLeaks(text);
    if (leaks.length > 0) {
      problems.push(`${where}: tells the model it is an evaluation (${leaks.join(", ")})`);
    }
    const { clauses, duplicates } = parsePolicyClauses(text);
    for (const d of duplicates) problems.push(`${where}: ${d} has more than one clause`);
    for (const id of ruleIds) {
      if (!clauses.has(id)) problems.push(`${where}: no clause for rule ${id}`);
    }
    for (const id of clauses.keys()) {
      if (!seen.has(id)) problems.push(`${where}: clause ${id} is not a rule of the manifest`);
    }
    if (previous) {
      const changed = ruleIds.filter((id) => previous!.get(id) !== clauses.get(id)).sort();
      const claimed = [...rev.changedRules].sort();
      if (changed.join() !== claimed.join()) {
        problems.push(
          `${where}: changes ${changed.join(",") || "nothing"}, but changedRules says ${claimed.join(",") || "nothing"}`,
        );
      }
    } else if (rev.changedRules.length > 0) {
      problems.push(`${where}: the first revision cannot change rules`);
    }
    previous = clauses;
  }
}

function validateItems(
  m: GoverningCorpusManifest,
  clauses: ReadonlyMap<string, string>,
  problems: string[],
): void {
  const summaries = new Map(m.rules.map((r) => [r.id, r.summary]));
  const ids = new Set<string>();
  let nonResemblingItems = 0;
  let negativeItems = 0;
  for (const item of m.items) {
    const where = `item ${item.id}`;
    if (ids.has(item.id)) problems.push(`${where}: duplicate id`);
    ids.add(item.id);
    const wording = `${item.title}\n${item.text}`;
    if (!item.title.trim() || !item.text.trim()) problems.push(`${where}: empty title or text`);
    const named = ruleIdsIn(wording);
    if (named.length > 0) problems.push(`${where}: names rule ids (${named.join(", ")})`);
    for (const [id, clause] of clauses) {
      const copied = sharedPhrases(wording, clause);
      if (copied.length > 0) problems.push(`${where}: copies ${id}'s wording ("${copied[0]}")`);
    }
    if (item.applies.length === 0) negativeItems++;
    const pairRules = new Set<string>();
    let hasNonResembling = false;
    for (const pair of item.applies) {
      const at = `${where} → ${pair.ruleId}`;
      if (pairRules.has(pair.ruleId)) problems.push(`${at}: listed twice`);
      pairRules.add(pair.ruleId);
      const clause = clauses.get(pair.ruleId);
      if (clause === undefined) {
        problems.push(`${at}: not a rule of the policy`);
        continue;
      }
      if (!(GOVERNING_VERDICTS as readonly string[]).includes(pair.verdict)) {
        problems.push(`${at}: unknown verdict ${JSON.stringify(pair.verdict)}`);
      }
      const fact = pair.businessFact?.trim() ?? "";
      if (pair.verdict === "needs-ba-input" && !fact) {
        problems.push(`${at}: needs-ba-input without the business fact a BA would supply`);
      }
      if (pair.verdict !== "needs-ba-input" && fact) {
        problems.push(`${at}: a business fact on a ${pair.verdict} pair`);
      }
      if (pair.nonResembling) {
        hasNonResembling = true;
        const shared = sharedVocabulary(wording, `${clause}\n${summaries.get(pair.ruleId) ?? ""}`);
        if (shared.length > 0) {
          problems.push(`${at}: labelled non-resembling but shares ${shared.join(", ")}`);
        }
      }
    }
    if (hasNonResembling) nonResemblingItems++;
  }
  if (nonResemblingItems < MIN_NON_RESEMBLING_ITEMS) {
    problems.push(
      `${nonResemblingItems} non-resembling item(s); at least ${MIN_NON_RESEMBLING_ITEMS} are needed`,
    );
  }
  if (negativeItems < MIN_NEGATIVE_ITEMS) {
    problems.push(`${negativeItems} negative item(s); at least ${MIN_NEGATIVE_ITEMS} are needed`);
  }
}

/**
 * #1900 — every other text of the manifest that reaches an arm's prompt (the
 * policy title, each rule summary, each requirement) must not tell the model
 * it is an evaluation either; the policy revisions are checked in
 * {@link validatePolicy}.
 */
function validatePromptTexts(m: GoverningCorpusManifest, problems: string[]): void {
  const report = (where: string, text: string) => {
    const leaks = evaluationLeaks(text);
    if (leaks.length > 0) {
      problems.push(`${where}: tells the model it is an evaluation (${leaks.join(", ")})`);
    }
  };
  report("the policy title", m.policy.title);
  for (const r of m.rules) report(`rule ${r.id}'s summary`, r.summary);
  for (const item of m.items) report(`item ${item.id}`, `${item.title}\n${item.text}`);
}

function validateThresholds(t: PassThresholds, problems: string[]): void {
  if (!t.recordedBeforeAnyArmRan) problems.push("thresholds: not recorded before any arm ran");
  for (const c of t.changes) {
    if (!c.issue?.trim() || !c.reason?.trim() || !c.at?.trim()) {
      problems.push("thresholds: a change without its issue, date and reason");
    }
  }
  const want = expectedThresholds(t.changes);
  for (const key of Object.keys(want) as Array<keyof ThresholdValues>) {
    if (t[key] !== want[key]) {
      problems.push(
        `thresholds: ${key} is ${t[key]}, but the proposal and its recorded changes give ${want[key]} (record the change and why)`,
      );
    }
  }
}

/**
 * Check a manifest against the corpus's files. Returns every problem found
 * (empty when the corpus is sound) so one run lists them all.
 */
export function validateGoverningCorpus(
  manifest: GoverningCorpusManifest,
  files: CorpusFiles,
): string[] {
  const problems: string[] = [];
  if (manifest.synthetic !== true) problems.push("the corpus must be marked synthetic");
  validateFiles(manifest, files, problems);
  validatePolicy(manifest, files, problems);
  const scored = files.policies.get(manifest.policy.scored);
  validateItems(manifest, scored ? parsePolicyClauses(scored).clauses : new Map(), problems);
  validatePromptTexts(manifest, problems);
  validateThresholds(manifest.thresholds, problems);
  return problems;
}

/** Absolute path of the `eval-data/corpus` root. */
export function governingCorpusRoot(): string {
  // server/src/lib/eval/governing → the repository root is five levels up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../../eval-data/corpus");
}

/** Resolve a registered corpus name; an unknown name throws with the known ones. */
export function resolveGoverningCorpusDir(name: string): string {
  if (!(GOVERNING_CORPORA as readonly string[]).includes(name)) {
    throw new Error(
      `unknown governing corpus: ${JSON.stringify(name)}. Known: ${GOVERNING_CORPORA.join(", ")}.`,
    );
  }
  return path.join(governingCorpusRoot(), name);
}

/** Every file under `dir`, relative and `/`-separated, sorted. */
export async function listCorpusFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .sort();
}

/** A revision's file, which must stay inside the corpus directory. */
function revisionPath(dir: string, rev: PolicyRevision): string {
  const resolved = path.resolve(dir, rev.file);
  const rel = path.relative(path.resolve(dir), resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `policy revision ${rev.revision}: ${JSON.stringify(rev.file)} leaves the corpus`,
    );
  }
  return resolved;
}

/**
 * Load and check a corpus. Throws, listing every problem, when it does not
 * hold together: a corpus that does not must fail before it produces a number.
 */
export async function loadGoverningCorpus(
  name: GoverningCorpusName,
  dir: string = resolveGoverningCorpusDir(name),
): Promise<GoverningCorpus> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
  ) as GoverningCorpusManifest;
  if (manifest.id !== name) {
    throw new Error(`corpus ${name}: manifest id is ${JSON.stringify(manifest.id)}`);
  }
  const policies = new Map<string, string>();
  for (const rev of manifest.policy.revisions) {
    policies.set(rev.revision, await fs.readFile(revisionPath(dir, rev), "utf8"));
  }
  const problems = validateGoverningCorpus(manifest, {
    present: await listCorpusFiles(dir),
    policies,
  });
  if (problems.length > 0) {
    throw new Error(`corpus ${name} is not sound:\n  - ${problems.join("\n  - ")}`);
  }
  const scored = manifest.policy.revisions.find((r) => r.revision === manifest.policy.scored)!;
  const policyText = policies.get(scored.revision)!;
  const { clauses } = parsePolicyClauses(policyText);
  const rules = manifest.rules.map((r) => ({ ...r, clause: clauses.get(r.id)! }));
  return {
    name,
    dir,
    manifest,
    policyFile: scored.file,
    policyText,
    rules,
    ruleById: new Map(rules.map((r) => [r.id, r])),
  };
}
