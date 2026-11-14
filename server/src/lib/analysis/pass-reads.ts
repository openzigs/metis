/**
 * #2448 (epic #2438) — an analysis's code passes read with the access of the
 * person who ran them, and each records what it read.
 *
 * Until #2448 every analysis read code as the shared audience (#2314): its
 * results are read by the whole project, so a file any access list restricts
 * was left out even when its starter could read it. With per-row provenance
 * (#2446) and the read-time filter (#2447) in place, a run a person starts
 * (`Analysis.sourceAccess = starter`) now reads code as that person, and a
 * reader who cannot see a file a row drew on sees the row redacted.
 *
 * Citations alone are not enough (#2448 thread): a pass that read a restricted
 * file can write a finding citing only an open one. So each pass records its
 * READ SET: the restricted documents it read, plus what the run's earlier
 * passes read (their output is this pass's input). It is stored on the pass's
 * `AgentResult.readSourceIds`, and folded into the `sourceIds` of every
 * finding the pass writes (`persistAgentResult`). Only restricted documents
 * are recorded: an open one hides nothing from anyone.
 *
 * What reads with the starter's access, and what does not:
 *   - inside a pass begun with {@link withPassReads}, the code-access filter
 *     ({@link passCodeAccess}): the code agent's file tools, its symbol search
 *     and its fused symbol seed. A restricted file the person may read is
 *     admitted only through a per-file check, which records it; the code
 *     graph's bulk query (`hiddenPaths`) still leaves it out, so nothing
 *     reaches the model unrecorded.
 *   - #2506 — inside a pass, the document reads too: the document reader,
 *     grounded and per-requirement retrieval, the code agent's
 *     `search_knowledge`, the quarantine fallback and the default document
 *     selection read as the person ({@link passSees}), and every restricted
 *     document they return is recorded ({@link recordPassReads}) before the
 *     model sees it. What a document pass writes on the run as a whole (the
 *     reviewed list, web research, clarifications, governing applicability,
 *     escalation) is shown only to a reader who can see the run as a whole
 *     (`canSeeRun`, whose corpus holds every pass's read set).
 *   - everything else stays on the shared audience: the affected-code links,
 *     the clarification dialog's self-resolve search, cross-document
 *     detection, and Spec Kit. They run outside any pass.
 *
 * Fail closed: when a pass cannot tell what the run's earlier passes read (one
 * of them recorded nothing), its read set is unknown (`null`), and so is every
 * finding it writes: a reader then sees them only if they can see everything
 * the run read. A person who cannot be resolved (deactivated mid-run) reads
 * as the shared audience, as a scheduled run does.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { SYSTEM_ACTOR_ID } from "../audit/system-actor.js";
import {
  InactiveAclActorError,
  isVisibleTo,
  parseAclSubjects,
  resolveAclActor,
  type AclActor,
} from "../rag/acl.js";
import {
  codeAccessFilterOf,
  normalizeRepoPath,
  repoDocumentPath,
  type CodeAccessFilter,
} from "./tools/code-access.js";
import { parseSourceIds, serializeSourceIds, SOURCE_ACCESS_STARTER } from "./source-ids.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("analysis-pass-reads");

type PassDb = Pick<PrismaClient, "analysis" | "agentResult" | "document">;

/** One code pass of a `starter` run: whose access it reads with, and what it has read. */
export interface PassReads {
  readonly analysisId: string;
  readonly projectId: string;
  readonly actor: AclActor;
  /** The project's restricted documents the actor may read, by id. */
  readonly readable: ReadonlySet<string>;
  /** The repository files among them: connector id → normalised path → document ids. */
  readonly readableFiles: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  /** The repository files hidden from the actor. */
  readonly hiddenFiles: ReadonlyArray<{ connectorId: string; path: string }>;
  /** What the run's earlier passes read (their stored read sets); `null`: one recorded none. */
  readonly upstream: ReadonlySet<string> | null;
  /** The restricted documents this pass has read so far. */
  readonly own: Set<string>;
}

const passes = new AsyncLocalStorage<PassReads>();

/** The pass of run `analysisId` the caller runs inside, if any. */
export function currentPassReads(analysisId: string): PassReads | undefined {
  const pass = passes.getStore();
  return pass && pass.analysisId === analysisId ? pass : undefined;
}

/** Record that `pass` read `documentIds`: each restricted one it may read is kept. */
export function recordPassReads(pass: PassReads, documentIds: Iterable<string>): void {
  for (const id of documentIds) if (pass.readable.has(id)) pass.own.add(id);
}

/** #2506 — whether the person running `pass` may read a document with this stored `aclSubjects`. */
export function passSees(pass: PassReads, aclSubjects: unknown): boolean {
  return isVisibleTo({ subjects: parseAclSubjects(aclSubjects) }, pass.actor);
}

/**
 * #2506 — the ids among `documentIds` (all in `projectId`) of live documents
 * the person running `pass` may read, in the order given. The pass's twin of
 * `sharedVisibleDocumentIds`.
 */
export async function passVisibleDocumentIds(
  pass: PassReads,
  projectId: string,
  documentIds: readonly string[],
  db: Pick<PrismaClient, "document"> = defaultPrisma,
): Promise<string[]> {
  if (documentIds.length === 0) return [];
  const rows = await db.document.findMany({
    where: { projectId, deletedAt: null, id: { in: [...documentIds] } },
    select: { id: true, aclSubjects: true },
  });
  const visible = new Set(rows.filter((r) => passSees(pass, r.aclSubjects)).map((r) => r.id));
  return documentIds.filter((id) => visible.has(id));
}

/**
 * The read set of run `analysisId` as its stored passes recorded it: the union
 * of their `readSourceIds`, or `null` when one recorded none (fail closed).
 * `exceptAgentKey`: leave out that agent's own results, which a pass of the
 * same agent replaces or continues and does not read (a regenerate, a resume).
 * Known coarseness (fails closed): other agents' rows include a synthesis row,
 * so a regenerated pass on a finished run inherits what the replaced pass read.
 */
export async function storedReadSet(
  db: Pick<PrismaClient, "agentResult">,
  analysisId: string,
  exceptAgentKey?: string,
): Promise<Set<string> | null> {
  const rows = await db.agentResult.findMany({
    where: { analysisId, ...(exceptAgentKey ? { agentKey: { not: exceptAgentKey } } : {}) },
    select: { readSourceIds: true },
  });
  const out = new Set<string>();
  for (const row of rows) {
    const ids = parseSourceIds(row.readSourceIds);
    if (!ids) return null;
    for (const id of ids.documentIds) out.add(id);
  }
  return out;
}

interface RestrictedDocument {
  id: string;
  visible: boolean;
  file: { connectorId: string; path: string } | null;
}

/** The project's live documents an access list restricts, and whether `actor` may read each. */
async function restrictedDocuments(
  db: Pick<PrismaClient, "document">,
  projectId: string,
  actor: AclActor,
): Promise<RestrictedDocument[]> {
  const rows = await db.document.findMany({
    where: { projectId, deletedAt: null, NOT: { aclSubjects: "[]" } },
    select: { id: true, filename: true, source: true, aclSubjects: true },
  });
  const out: RestrictedDocument[] = [];
  for (const row of rows) {
    const subjects = parseAclSubjects(row.aclSubjects);
    if (subjects.length === 0) continue;
    out.push({
      id: row.id,
      visible: isVisibleTo({ subjects }, actor),
      // The same rows the code filter matches (`loadCodeAccessFilterFor`).
      file: row.source === "repo" ? repoDocumentPath(row.filename) : null,
    });
  }
  return out;
}

/** Which pass: its run, the person who runs it, and the agent it is. */
export interface PassInput {
  analysisId: string;
  actorId?: string | null;
  /** The agent the pass is (`code`, `document`, ...); its own earlier results are not its input. */
  agentKey?: string;
}

/**
 * The pass of run `analysisId` that `actorId` runs, or `null` when it reads as
 * the shared audience: the run is not a `starter` run, nobody ran it (a
 * scheduled run, the system actor), or that person cannot be resolved now.
 */
export async function beginPassReads(
  input: PassInput,
  db: PassDb = defaultPrisma as unknown as PassDb,
): Promise<PassReads | null> {
  const actorId = input.actorId;
  if (!actorId || actorId === SYSTEM_ACTOR_ID) return null;
  const run = await db.analysis.findUnique({
    where: { id: input.analysisId },
    select: { projectId: true, sourceAccess: true },
  });
  if (!run || run.sourceAccess !== SOURCE_ACCESS_STARTER) return null;
  let actor: AclActor;
  try {
    actor = await resolveAclActor(actorId);
  } catch (err) {
    if (err instanceof InactiveAclActorError) return null;
    throw err;
  }
  const [documents, upstream] = await Promise.all([
    restrictedDocuments(db, run.projectId, actor),
    storedReadSet(db, input.analysisId, input.agentKey),
  ]);
  const readable = new Set<string>();
  const readableFiles = new Map<string, Map<string, string[]>>();
  const hiddenFiles: Array<{ connectorId: string; path: string }> = [];
  for (const doc of documents) {
    if (!doc.visible) {
      if (doc.file) hiddenFiles.push(doc.file);
      continue;
    }
    readable.add(doc.id);
    if (!doc.file) continue;
    let paths = readableFiles.get(doc.file.connectorId);
    if (!paths) readableFiles.set(doc.file.connectorId, (paths = new Map()));
    paths.set(doc.file.path, [...(paths.get(doc.file.path) ?? []), doc.id]);
  }
  return {
    analysisId: input.analysisId,
    projectId: run.projectId,
    actor,
    readable,
    readableFiles,
    hiddenFiles,
    upstream,
    own: new Set(),
  };
}

/**
 * Run `fn` as one pass of run `analysisId` by `actorId`: inside it,
 * {@link currentPassReads} answers, and `persistAgentResult` records the
 * pass's read set. Runs `fn` unchanged when the pass reads as the shared
 * audience ({@link beginPassReads}).
 */
export async function withPassReads<T>(
  input: PassInput,
  fn: () => Promise<T>,
  db?: PassDb,
): Promise<T> {
  let pass: PassReads | null = null;
  try {
    pass = await beginPassReads(input, db);
  } catch (err) {
    // The shared audience reads less than anyone, so a pass that cannot learn
    // whose access to read with reads as it: never as someone unchecked.
    log.warn("Could not begin a pass with its runner's access; reading as the shared audience", {
      analysisId: input.analysisId,
      error: String(err),
    });
  }
  return pass ? passes.run(pass, fn) : fn();
}

/**
 * The code-access filter of `pass`: what is hidden from the person who runs
 * it, with each restricted file they may read recorded when a per-file check
 * admits it (`isHidden`). The bulk exclusion list (`hiddenPaths`, the code
 * graph's query) leaves those files out as well, so a restricted file reaches
 * the model only through a check that records it.
 */
// Known coarseness (fails closed): `isHidden` records a readable restricted
// file whenever it is checked, so a directory listing or a fused-search seed
// records every such file it walks, not only the ones actually read.
export function passCodeAccess(pass: PassReads): CodeAccessFilter {
  const hidden = codeAccessFilterOf(pass.hiddenFiles);
  if (pass.readableFiles.size === 0) return hidden;
  const readableIn = (repo: string | null): Array<ReadonlyMap<string, readonly string[]>> =>
    repo === null
      ? [...pass.readableFiles.values()]
      : pass.readableFiles.has(repo)
        ? [pass.readableFiles.get(repo)!]
        : [];
  return {
    unrestricted: false,
    hiddenPaths: (repo) => [
      ...new Set([...hidden.hiddenPaths(repo), ...readableIn(repo).flatMap((m) => [...m.keys()])]),
    ],
    isHidden: (repo, filePath) => {
      if (hidden.isHidden(repo, filePath)) return true;
      const p = normalizeRepoPath(filePath);
      for (const paths of readableIn(repo)) recordPassReads(pass, paths.get(p) ?? []);
      return false;
    },
    hiddenFileCount: hidden.hiddenFileCount,
  };
}

/**
 * What `persistAgentResult` records for a result of run `analysisId`:
 *   - `undefined`: the run is not a `starter` run, so nothing is recorded and
 *     its findings record their citations only, as before;
 *   - a list: the read set of the pass the caller runs inside (what earlier
 *     passes of other agents read, and what it read), or, outside any pass
 *     (synthesis, the custom agents), everything the run's stored results
 *     read so far, its own earlier one included. Synthesis is the one place
 *     where a run's corpus never shrinks: a reviewed requirement it wrote
 *     outlives a code pass someone else regenerates, and still rests on what
 *     that pass read;
 *   - `null`: that cannot be told (fail closed).
 */
export async function readSetForPersist(
  analysisId: string,
  db: PassDb = defaultPrisma as unknown as PassDb,
): Promise<string[] | null | undefined> {
  const pass = currentPassReads(analysisId);
  if (pass) return pass.upstream ? [...new Set([...pass.upstream, ...pass.own])].sort() : null;
  if (!(await readsWithStarterAccess(analysisId, db))) return undefined;
  const stored = await storedReadSet(db, analysisId);
  return stored ? [...stored].sort() : null;
}

/** Whether run `analysisId` is a `starter` run (its code passes read with a person's access). */
export async function readsWithStarterAccess(
  analysisId: string,
  db: Pick<PrismaClient, "analysis"> = defaultPrisma,
): Promise<boolean> {
  const run = await db.analysis.findUnique({
    where: { id: analysisId },
    select: { sourceAccess: true },
  });
  return run?.sourceAccess === SOURCE_ACCESS_STARTER;
}

/**
 * Whether what run `analysisId` wrote may rest on a restricted read: a
 * `starter` run whose stored passes read a restricted file, or whose read set
 * cannot be told (fail closed). A run whose passes all read nothing restricted
 * (a project with no access lists) is as open as a `shared` one.
 */
export async function mayRestOnRestrictedRead(
  analysisId: string,
  db: Pick<PrismaClient, "analysis" | "agentResult"> = defaultPrisma,
): Promise<boolean> {
  if (!(await readsWithStarterAccess(analysisId, db))) return false;
  const stored = await storedReadSet(db, analysisId);
  return stored === null || stored.size > 0;
}

/** The stored form of a read set (`AgentResult.readSourceIds`). */
export function serializeReadSet(documentIds: readonly string[]): string {
  return serializeSourceIds({ documentIds: [...documentIds], chunkIds: [] });
}
