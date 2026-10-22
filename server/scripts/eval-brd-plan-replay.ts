/**
 * Issue #1352 — replay a planned business-requirements run OFFLINE: its topic
 * plan from the Phase-1 facts it was written from, and its assembly from the
 * sections it stored. No model is called and nothing is written.
 *
 * It compares four configurations of the plan (#1352):
 *   - the footnote reserve: the module definitions alone (before #1352), or
 *     each module's definition plus N characters for the pinned lines,
 *     canonical facts and excerpts it brings (`--allowances`, default 0,80,98,100);
 *   - the single-call length note: only when the section was itself given less
 *     than it asks (before #1352), or whenever its part's budget binds.
 *
 * For each it reports, from the PLAN: the reserve, the characters planned
 * against the run's body (`--body-max`, the logged `bodyMaxChars`, which the
 * manifest does not store), the module-per-section topics planned out, and the
 * modules planned out of every catalogue section (absent from the catalogue
 * altogether). From the ASSEMBLY, a model that writes exactly to its plan is
 * simulated on the stored text: each catalogue section is split back into its
 * batch replies (`decodePartRuns`), each reply held to its share as #1327
 * holds it (shares scaled by the section's budget in this configuration) and
 * then written to exactly that share; a single-call section is written to its
 * planned length when its prompt states one, else as it was written. Then the
 * section cap and the document fit run as at assembly. It counts the H3
 * themes not written, the H3 themes cut at section ends by the fit, and their
 * sum, and says whether `--watch` themes survive.
 *
 * Caveat: the stored replies were written to the run's own plan, so a module
 * newly planned out still has text here; the simulation scales shares, it
 * cannot remove that module's text. The "as written" row is the control: on
 * run B under the #1327 hold with `--no-canonical-rank` it reproduces 45
 * themes cut (72 topics listed); ranking canonical facts as the synthesizer
 * does, 44 (71), and 42 (69) once tied topics go smaller first (#1368).
 *
 * #1368 — a batch's topics are ranked as the synthesizer ranks them, canonical
 * facts by their module (`--no-canonical-rank` for the replay before #1368,
 * which ranked module facts only), and a `--watch` theme that survives is
 * reported with the rendered characters under it: a heading a later batch
 * re-emitted over a line ("kept (43)") is not a written theme. That size is a
 * range when another batch wrote below the theme ("kept (2123-2400)"): what
 * the batch that wrote its heading wrote there, and everything below the
 * heading, H4s another batch may have opened with included.
 *
 * How ranks are approximated, unlike the synthesizer:
 *   - a module-facts citation's rank is its id's trailing index
 *     (`facts:<module>:<index>`), whatever repository the id names;
 *   - a canonical fact's module is the FOLDER of the file in its evidence
 *     label (`selectedEvidence.primary[].label`, `path/file.go:12 — NAME`),
 *     not `CanonicalFact.modulePath`, which the manifest does not store. The
 *     two agree when Phase 1 groups a module by folder, as it did for run B;
 *   - that folder is matched to a path alone, ignoring repository identity,
 *     so in a multi-repository run two repositories' same-named folders
 *     share one rank (the first cited);
 *   - only a module the section cites has an index (the synthesizer ranks
 *     every module the section read, which can only make a rank more
 *     important).
 *
 *   npx tsx scripts/eval-brd-plan-replay.ts --db ../server/dev.db \
 *     --version cmvi3h71u00e9o99k3c0iq4ec --body-max 234277
 *
 * The database is opened READ-ONLY (`readonly: true, fileMustExist: true`).
 * Phase-1 facts are read from `docs_gen_fact_cache` rows for the run's
 * project and model last used in the half hour before the version was
 * written (`--facts-window-min`): a later run that reuses them moves that
 * timestamp, so replay before re-running, or widen the window.
 */
/* eslint-disable no-console -- a local CLI whose output is the table it prints */
import Database from "better-sqlite3";
import { renderedCitationLength } from "../src/lib/docs-gen/citation-footnotes.js";
import { citedSourceIds, holdBatchReply } from "../src/lib/docs-gen/batch-hold.js";
import {
  decodePartRuns,
  fitDocumentToPlan,
  fitSectionToPlan,
  plannedOmissionNote,
  splitClosingNote,
  type DocumentPlan,
  type PlanFitSection,
} from "../src/lib/docs-gen/document-plan.js";
import {
  FOOTNOTE_DEFINITION_OVERHEAD,
  FOOTNOTE_RESERVE_SHARE,
  docsGenTuning,
  footnoteReserveChars,
  planDocumentTopics,
  sectionGroupsFor,
  singleCallLengthLimited,
  type ModuleFacts,
  type Phase2Router,
} from "../src/lib/docs-gen/holistic-synthesizer.js";
import { mergePhase1ChunkFacts } from "../src/lib/docs-gen/phase1-chunking.js";
import { mergeBatchBlocks } from "../src/lib/docs-gen/section-batching.js";
import { units } from "../src/lib/docs-gen/section-size.js";

interface Args {
  db: string;
  version: string;
  bodyMax: number;
  documentMax: number;
  sectionMax: number;
  allowances: number[];
  watch: string[];
  factsWindowMin: number;
  list: boolean;
  /** Rank canonical-fact citations by their module, as the synthesizer does (#1368). */
  canonicalRank: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    db: get("db") ?? "dev.db",
    version: get("version") ?? "cmvi3h71u00e9o99k3c0iq4ec",
    bodyMax: Number(get("body-max") ?? 234_277),
    documentMax: Number(get("document-max") ?? 250_000),
    sectionMax: Number(get("section-max") ?? 60_000),
    allowances: (get("allowances") ?? "0,80,98,100").split(",").map(Number),
    watch: (get("watch") ?? "Content Entities,Entry and Media Entities").split(","),
    factsWindowMin: Number(get("facts-window-min") ?? 30),
    list: argv.includes("--list"),
    canonicalRank: !argv.includes("--no-canonical-rank"),
  };
}

interface StoredRecord {
  sectionId: string;
  markdown: string;
  metadata: { sectionLabel: string; model?: string; omittedTopics?: string[] };
  parts?: { budgets: number[]; runs: Array<[number, number]> };
}

interface Run {
  facts: ModuleFacts[];
  records: StoredRecord[];
  storedPlan: {
    budgetChars: number;
    sections: Array<{ sectionLabel: string; budgetChars: number }>;
  };
  model: string;
  /** The module directory of each canonical fact, by its source id (#1368). */
  canonicalModuleOf: Map<string, string>;
}

function load(args: Args): Run {
  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  try {
    const version = db
      .prepare(
        `select v.provenanceManifest as manifest, v.createdAt as createdAt, g.projectId as projectId
         from generated_document_versions v join generated_documents g on g.id = v.documentId
         where v.id = ?`,
      )
      .get(args.version) as { manifest: string; createdAt: string; projectId: string } | undefined;
    if (!version) throw new Error(`no generated document version ${args.version}`);
    const manifest = JSON.parse(version.manifest) as {
      sectionSynthesis: { records: StoredRecord[] };
      topicPlan: Run["storedPlan"];
      selectedEvidence?: { primary?: Array<{ sourceId: string; label: string }> };
    };
    // A canonical fact's evidence label is `path/to/file.go:12 — NAME = value`;
    // its module is the file's directory, as Phase 1 groups modules.
    const canonicalModuleOf = new Map<string, string>();
    for (const item of manifest.selectedEvidence?.primary ?? []) {
      if (!item.sourceId.startsWith("facts:canon:")) continue;
      const file = item.label.split(":")[0];
      canonicalModuleOf.set(item.sourceId, file.slice(0, Math.max(0, file.lastIndexOf("/"))));
    }
    const records = manifest.sectionSynthesis.records;
    const model = records[0]?.metadata.model ?? "";
    const until = new Date(version.createdAt);
    const since = new Date(until.getTime() - args.factsWindowMin * 60_000);
    const rows = db
      .prepare(
        `select modulePath, facts, formulasJson, minedRulesJson, topClassesJson, classCount, methodCount
         from docs_gen_fact_cache
         where projectId = ? and model = ? and lastUsedAt >= ? and lastUsedAt <= ?
         order by modulePath, createdAt`,
      )
      .all(version.projectId, model, since.toISOString(), until.toISOString()) as Array<
      Record<string, string | number>
    >;
    const byPath = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byPath.get(String(r.modulePath)) ?? [];
      list.push(r);
      byPath.set(String(r.modulePath), list);
    }
    const facts = [...byPath].map(([modulePath, list]): ModuleFacts => ({
      modulePath,
      moduleName: modulePath.split("/").pop() || modulePath,
      classCount: Number(list[0].classCount),
      methodCount: Number(list[0].methodCount),
      facts: mergePhase1ChunkFacts(list.map((r) => String(r.facts))),
      formulas: list.flatMap((r) => JSON.parse(String(r.formulasJson)) as ModuleFacts["formulas"]),
      minedRules: list.flatMap(
        (r) => JSON.parse(String(r.minedRulesJson)) as NonNullable<ModuleFacts["minedRules"]>,
      ),
      topClasses: JSON.parse(String(list[0].topClassesJson)) as ModuleFacts["topClasses"],
    }));
    return { facts, records, storedPlan: manifest.topicPlan, model, canonicalModuleOf };
  } finally {
    db.close();
  }
}

function routerFor(model: string): Phase2Router {
  const tuning = docsGenTuning("anthropic", model);
  return {
    primary: {
      kind: "anthropic",
      provider: { key: "anthropic", model, offline: false } as never,
      supportsCaching: false,
      factsCharCap: tuning.factsCharCap,
      tuning,
    },
    hybrid: null,
  };
}

/** The reserve before #1352 (module definitions alone, at most 5%) or with an allowance. */
function reserveWith(
  facts: readonly ModuleFacts[],
  documentMax: number,
  allowance: number | null,
): number {
  if (allowance === null) {
    return Math.min(
      Math.floor(documentMax * 0.05),
      facts.reduce((n, f) => n + f.modulePath.length + FOOTNOTE_DEFINITION_OVERHEAD, 0),
    );
  }
  return Math.min(
    Math.floor(documentMax * FOOTNOTE_RESERVE_SHARE),
    facts.reduce((n, f) => n + f.modulePath.length + FOOTNOTE_DEFINITION_OVERHEAD + allowance, 0),
  );
}

/**
 * The plan under a given reserve. `planDocumentTopics` computes its own
 * reserve (`footnoteReserveChars`); the document cap it is given is shifted so
 * that what it shares is the cap less the reserve wanted.
 */
function planWith(run: Run, args: Args, reserve: number) {
  const shift = (cap: number): number => footnoteReserveChars(run.facts, cap);
  let cap = args.documentMax - reserve + shift(args.documentMax);
  for (let i = 0; i < 4; i++) cap = args.documentMax - reserve + shift(cap);
  const planning = planDocumentTopics({
    facts: run.facts,
    groups: sectionGroupsFor("business-requirements"),
    router: routerFor(run.model),
    sectionMaxChars: args.sectionMax,
    documentMaxChars: cap,
  });
  if (planning.plan.budgetChars !== args.documentMax - reserve) {
    throw new Error(
      `plan shares ${planning.plan.budgetChars}, wanted ${args.documentMax - reserve}`,
    );
  }
  return planning;
}

/** The single-call sections told a length before #1352: given less than they ask. */
function toldBefore(plan: Pick<DocumentPlan, "sections">): Set<string> {
  return new Set(
    plan.sections
      .filter((s) => s.kind === "single" && s.budgetChars < s.demandChars)
      .map((s) => s.sectionId),
  );
}

const h3 = (md: string): Set<string> =>
  new Set([...md.matchAll(/^### (.+?)\s*$/gm)].map((m) => m[1].trim()));

/**
 * The rendered characters written under every `### theme` of a section, as a
 * range. `upTo`: everything below the heading up to the next H2 or H3, its
 * H4s included. `own`: only what the batch that wrote the heading wrote there
 * (`partOf`, the batch of each unit of the section's body), or, with no parts,
 * the heading's own body up to the next heading of any depth. The merge puts
 * a later batch's H4 under the H3 an earlier batch wrote, whether that batch
 * wrote it under the same theme or opened its reply with it, and a stored
 * section does not say which, so the theme's written size is between the two.
 */
function themeChars(
  markdown: string,
  theme: string,
  partOf?: readonly number[],
): { own: number; upTo: number } {
  const body = units(splitClosingNote(markdown).body);
  const parts = partOf?.length === body.length ? partOf : undefined;
  let own = 0;
  let upTo = 0;
  let inTheme = false;
  let headingPart = -1;
  let inBody = false;
  body.forEach((u, i) => {
    if (u.depth > 0 && u.depth <= 3) {
      inTheme = u.depth === 3 && u.text.slice(4).trim() === theme;
      headingPart = parts?.[i] ?? -1;
    }
    if (u.depth > 0) inBody = inTheme && u.depth === 3;
    const n = renderedCitationLength(u.text) + 2;
    if (inTheme) upTo += n;
    if (parts ? inTheme && parts[i] === headingPart : inBody) own += n;
  });
  return { own, upTo };
}

/** `markdown` as a model writing exactly `budget` rendered characters of it would. */
function writtenTo(markdown: string, budget: number): string {
  if (renderedCitationLength(markdown) <= budget) return markdown;
  const kept: string[] = [];
  let used = 0;
  for (const u of units(markdown)) {
    const c = renderedCitationLength(u.text) + 2;
    if (used + c > budget && kept.length > 0) {
      const room = budget - used - 2;
      if (u.depth === 0 && room > 80) {
        let lo = 0;
        let hi = u.text.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (renderedCitationLength(u.text.slice(0, mid)) <= room) lo = mid;
          else hi = mid - 1;
        }
        if (lo > 0) kept.push(u.text.slice(0, lo));
      }
      break;
    }
    kept.push(u.text);
    used += c;
  }
  while (kept.length > 1 && /^#{1,6}\s/.test(kept[kept.length - 1])) kept.pop();
  return kept.join("\n\n");
}

/** A stored catalogue section split back into the replies of its batches. */
function repliesOf(record: StoredRecord): string[] {
  const all = units(splitClosingNote(record.markdown).body);
  const partOf = decodePartRuns(record.parts!.runs);
  if (partOf.length !== all.length) throw new Error(`${record.sectionId}: parts do not align`);
  const replies: string[][] = record.parts!.budgets.map(() => [all[0].text]);
  let cur3: string | null = null;
  let cur4: string | null = null;
  const last3 = new Map<number, string | null>();
  const last4 = new Map<number, string | null>();
  all.forEach((u, i) => {
    if (i === 0) return;
    if (u.depth === 3) {
      cur3 = u.text;
      cur4 = null;
    } else if (u.depth === 4) cur4 = u.text;
    const p = partOf[i];
    if (u.depth === 3) {
      replies[p].push(u.text);
      last3.set(p, u.text);
      last4.set(p, null);
      return;
    }
    if (cur3 && last3.get(p) !== cur3) {
      replies[p].push(cur3);
      last3.set(p, cur3);
      last4.set(p, null);
    }
    if (u.depth === 4) {
      replies[p].push(u.text);
      last4.set(p, u.text);
      return;
    }
    if (cur4 && last4.get(p) !== cur4) {
      replies[p].push(cur4);
      last4.set(p, cur4);
    }
    replies[p].push(u.text);
  });
  return replies.map((parts) => parts.join("\n\n"));
}

/** A repository module's facts id: `facts:repo:<encoded [connector, graph, path]>:<index>`. */
const MODULE_FACTS_ID = /^facts:repo:([^:]+):(\d+)$/;

/**
 * The rank a citation in `record` names, as the synthesizer ranks it when it
 * holds a batch (`rankOfSource`): a module's facts by the module's index in
 * the section, and (#1368, unless `--no-canonical-rank`) a canonical fact by
 * its module's index. Before #1368 the replay ranked module facts only, so a
 * topic whose most important citation was a canonical fact of the section's
 * top module ranked lower here than in the run. Only a module the section
 * cites has an index here; the synthesizer also ranks a module it read but no
 * topic cited, which can only make a rank more important.
 */
function rankerFor(record: StoredRecord, run: Run, args: Args): (id: string) => number | undefined {
  const indexOf = new Map<string, number>();
  for (const id of citedSourceIds(record.markdown)) {
    const m = MODULE_FACTS_ID.exec(id);
    if (!m) continue;
    const parts = JSON.parse(decodeURIComponent(m[1])) as unknown[];
    const path = parts[parts.length - 1];
    if (typeof path === "string" && !indexOf.has(path)) indexOf.set(path, Number(m[2]));
  }
  return (id) => {
    if (id.startsWith("facts:canon:")) {
      const path = args.canonicalRank ? run.canonicalModuleOf.get(id) : undefined;
      return path === undefined ? undefined : indexOf.get(path);
    }
    const m = /^facts:(?!canon:|symbol:).*:(\d+)$/.exec(id);
    return m ? Number(m[1]) : undefined;
  };
}

interface Assembly {
  offered: number;
  notWritten: string[];
  cut: string[];
  listed: number;
  watch: string[];
}

function assemble(
  run: Run,
  args: Args,
  budgetOf: (record: StoredRecord) => number,
  options: { toPlan: boolean; told: ReadonlySet<string> },
): Assembly {
  const oldBudget = (r: StoredRecord): number =>
    run.storedPlan.sections.find((s) => s.sectionLabel === r.metadata.sectionLabel)!.budgetChars;
  const notWritten: string[] = [];
  const input: PlanFitSection[] = run.records.map((r) => {
    if (!r.parts) {
      const md =
        options.toPlan && options.told.has(r.sectionId)
          ? writtenTo(r.markdown, budgetOf(r))
          : r.markdown;
      notWritten.push(
        ...[...h3(r.markdown)].filter((t) => !h3(md).has(t)).map((t) => `${r.sectionId}: ${t}`),
      );
      return {
        markdown: md,
        budgetChars: budgetOf(r),
        alreadyOmitted: r.metadata.omittedTopics ?? [],
      };
    }
    const scale = budgetOf(r) / oldBudget(r);
    const budgets = r.parts.budgets.map((b) => Math.floor(b * scale));
    const rankOf = rankerFor(r, run, args);
    const held = repliesOf(r).map((text, p) => {
      const h = holdBatchReply(text, budgets[p], {
        measure: renderedCitationLength,
        rankOf,
      }).markdown;
      if (!options.toPlan) return h;
      const kept = writtenTo(h, budgets[p]);
      notWritten.push(
        ...[...h3(text)].filter((t) => !h3(kept).has(t)).map((t) => `${r.sectionId}: ${t}`),
      );
      return kept;
    });
    const blocks = mergeBatchBlocks(held, r.metadata.sectionLabel);
    const already = [...(r.metadata.omittedTopics ?? [])];
    const fit = fitSectionToPlan(
      {
        markdown: `${blocks.map((b) => b.text).join("\n\n")}\n\n${plannedOmissionNote(already, {
          setting: "DOCS_GEN_DOCUMENT_MAX_CHARS",
          maxChars: args.documentMax,
        })}`,
        budgetChars: budgetOf(r),
        parts: { budgets, partOf: blocks.flatMap((b) => units(b.text).map(() => b.reply)) },
        alreadyOmitted: already,
      },
      args.sectionMax,
      renderedCitationLength,
    );
    return {
      markdown: fit.sections[0],
      budgetChars: budgetOf(r),
      ...(fit.parts[0] ? { parts: fit.parts[0] } : {}),
      alreadyOmitted: fit.omittedTopics[0],
    };
  });
  const fit = fitDocumentToPlan(input, args.bodyMax, renderedCitationLength, args.documentMax);
  const cut: string[] = [];
  let listed = 0;
  run.records.forEach((r, i) => {
    const after = h3(fit.sections[i]);
    cut.push(
      ...[...h3(input[i].markdown)].filter((t) => !after.has(t)).map((t) => `${r.sectionId}: ${t}`),
    );
    listed += fit.omittedTopics[i].filter((t) => !t.includes("(not planned)")).length;
  });
  const final = new Set(fit.sections.flatMap((s) => [...h3(s)]));
  const written = new Set(run.records.flatMap((r) => [...h3(r.markdown)]));
  return {
    offered: input.reduce((n, s) => n + renderedCitationLength(s.markdown), 0),
    notWritten,
    cut,
    listed,
    // #1368 — "kept" with the rendered characters under the theme's headings,
    // so a heading a part re-emitted over a line or two is not read as written.
    watch: args.watch.map((t) => {
      if (!written.has(t)) return `${t}: absent`;
      if (!final.has(t)) return `${t}: LOST`;
      const size = fit.sections.map((s, i) => themeChars(s, t, fit.parts[i]?.partOf));
      const own = size.reduce((n, s) => n + s.own, 0);
      const upTo = size.reduce((n, s) => n + s.upTo, 0);
      return `${t}: kept (${own === upTo ? own : `${own}-${upTo}`})`;
    }),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const run = load(args);
  console.log(
    `version ${args.version}: ${run.facts.length} modules, model ${run.model}, stored plan ${run.storedPlan.budgetChars}, body ${args.bodyMax}`,
  );
  const stored = (r: StoredRecord): number =>
    run.storedPlan.sections.find((s) => s.sectionLabel === r.metadata.sectionLabel)!.budgetChars;
  const control = assemble(run, args, stored, { toPlan: false, told: new Set() });
  console.log(
    `control, as written under the stored plan: ${control.cut.length} themes cut at section ends, ${control.listed} topics listed; ${control.watch.join("; ")}`,
  );
  console.log(
    [
      "reserve".padEnd(16),
      "note".padEnd(7),
      "reserved".padStart(8),
      "planned".padStart(8),
      "fits".padStart(5),
      "out-pairs".padStart(9),
      "out-all4".padStart(8),
      "offered".padStart(8),
      "not-written".padStart(11),
      "cut-at-end".padStart(10),
      "themes-lost".padStart(11),
      " watch",
    ].join(" "),
  );
  for (const allowance of [null, ...args.allowances.filter((a) => a > 0)]) {
    const reserve = reserveWith(run.facts, args.documentMax, allowance);
    const planning = planWith(run, args, reserve);
    const catalogue = planning.plan.sections.filter((s) => s.kind === "enumerative");
    const outPairs = catalogue.reduce((n, s) => n + s.dropped.length, 0);
    const outEverywhere = new Set(catalogue[0]?.dropped.map((t) => t.title.split(" — ")[0]) ?? []);
    for (const s of catalogue.slice(1)) {
      const here = new Set(s.dropped.map((t) => t.title.split(" — ")[0]));
      for (const m of [...outEverywhere]) if (!here.has(m)) outEverywhere.delete(m);
    }
    const budgetOf = (r: StoredRecord): number =>
      planning.plan.sections.find((s) => s.label === r.metadata.sectionLabel)!.budgetChars;
    for (const note of ["before", "binds"] as const) {
      const told =
        note === "before"
          ? toldBefore(planning.plan)
          : singleCallLengthLimited(planning.plan, { reader: false });
      const a = assemble(run, args, budgetOf, { toPlan: true, told });
      console.log(
        [
          (allowance === null ? "modules only" : `+${allowance}/module`).padEnd(16),
          note.padEnd(7),
          String(reserve).padStart(8),
          String(planning.plan.budgetChars).padStart(8),
          (planning.plan.budgetChars <= args.bodyMax ? "yes" : "no").padStart(5),
          String(outPairs).padStart(9),
          String(outEverywhere.size).padStart(8),
          String(a.offered).padStart(8),
          String(a.notWritten.length).padStart(11),
          String(a.cut.length).padStart(10),
          String(a.notWritten.length + a.cut.length).padStart(11),
          ` ${a.watch.join("; ")}`,
        ].join(" "),
      );
      if (args.list) {
        console.log(`   planned out of all four: ${[...outEverywhere].join(", ") || "none"}`);
        console.log(`   not written: ${a.notWritten.join(" | ")}`);
        console.log(`   cut: ${a.cut.join(" | ")}`);
      }
    }
  }
}

main();
