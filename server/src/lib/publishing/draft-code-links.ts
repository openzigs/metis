/**
 * #1064 — the "Related code" section of an issue draft.
 *
 * A requirement's code links (`RequirementCodeMapping`) were shown on its
 * traceability panel and nowhere in the issue a developer receives. This module
 * renders the links that are ALREADY PERSISTED for the requirement, in this
 * project: it never derives, re-ranks or filters them, so whatever rule decided
 * which links exist (and "no link" is one of its outcomes) is the only rule.
 *
 * Paths and symbol names come from an ingested repository, so they are
 * untrusted text going into a Markdown body that GitHub renders:
 *   - each is written inside an inline code span, where neither HTML nor
 *     Markdown is interpreted, with a fence longer than any backtick run in it;
 *   - control characters (a newline would end the span's line) become spaces;
 *   - a link is written only to the project's own repository, on an https
 *     origin, at a known ref, for a plain repository-relative path, with every
 *     segment URL-encoded. Otherwise the path stays text.
 * The link rules mirror `ui/src/lib/code-citation-blob-url.ts` (#728), which
 * the server cannot import.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("draft-code-links");

/** The most code links one issue body lists; the rest are counted, not shown. */
export const MAX_DRAFT_CODE_LINKS = 10;

/** The longest path or symbol name written; longer ones are cut with an ellipsis. */
const MAX_CODE_TEXT = 200;

export interface DraftCodeLink {
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  symbolName: string | null;
  symbolKind: string | null;
}

/** Where the project's code is browsable: origin + owner/repo at a ref. */
export interface CodeLinkRepo {
  /** `https://github.com` or a GitHub Enterprise https origin. */
  origin: string;
  owner: string;
  repo: string;
  /** The ingested commit SHA when known, else the connector's branch. */
  ref: string;
}

export interface CodeLinkRepoSource {
  provider: string;
  ownerOrOrg: string | null;
  repoName: string | null;
  defaultBranch: string | null;
  apiBaseUrl: string | null;
  lastCommitSha: string | null;
}

const GITHUB_ORIGIN = "https://github.com";
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const CONTROL_RE_GLOBAL = /[\u0000-\u001f\u007f]/g;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const KIND_RE = /^[a-z][a-z_-]{0,19}$/;

function githubWebOrigin(provider: string, apiBaseUrl: string | null): string | null {
  if (!apiBaseUrl) return provider === "github" ? GITHUB_ORIGIN : null;
  let parsed: URL;
  try {
    parsed = new URL(apiBaseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname.toLowerCase() === "api.github.com") return GITHUB_ORIGIN;
  // `origin` drops any path (`/api/v3`) and any embedded credentials.
  return parsed.origin;
}

/**
 * The repository a project's code links point into: its single live GitHub or
 * GitHub Enterprise connector. A code link carries no connector id, so with
 * none or several the target is not known and this is `null` (paths stay text).
 */
export function selectCodeLinkRepo(connectors: readonly CodeLinkRepoSource[]): CodeLinkRepo | null {
  const github = connectors.filter(
    (c) => c.provider === "github" || c.provider === "github_enterprise",
  );
  if (github.length !== 1) return null;
  const c = github[0]!;
  const origin = githubWebOrigin(c.provider, c.apiBaseUrl);
  const owner = c.ownerOrOrg ?? "";
  const repo = c.repoName ?? "";
  if (!origin || !NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;
  const sha = c.lastCommitSha?.trim();
  const ref = sha && SHA_RE.test(sha) ? sha : (c.defaultBranch ?? "");
  if (!ref || !REF_RE.test(ref) || ref.split("/").includes("..")) return null;
  return { origin, owner, repo, ref };
}

/** Repository-relative path segments, or `null` if the path is not safe to link. */
function safePathSegments(filePath: string): string[] | null {
  if (!filePath || CONTROL_RE.test(filePath) || filePath.includes("\\")) return null;
  if (filePath.startsWith("/") || SCHEME_RE.test(filePath)) return null;
  const segments = filePath.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return segments;
}

/** `encodeURIComponent`, plus the parentheses a Markdown link target ends on. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function lineRange(link: Pick<DraftCodeLink, "startLine" | "endLine">): [number, number] | null {
  const { startLine, endLine } = link;
  if (startLine === null || !Number.isInteger(startLine) || startLine < 1) return null;
  const end = endLine !== null && Number.isInteger(endLine) && endLine > startLine ? endLine : null;
  return [startLine, end ?? startLine];
}

/**
 * `https://<host>/<owner>/<repo>/blob/<ref>/<path>#L<start>-L<end>`, or `null`
 * when there is no repository or the path is not a plain relative one.
 */
export function buildCodeLinkUrl(repo: CodeLinkRepo | null, link: DraftCodeLink): string | null {
  if (!repo) return null;
  const segments = safePathSegments(link.filePath);
  if (!segments) return null;
  const range = lineRange(link);
  const fragment = !range
    ? ""
    : range[0] === range[1]
      ? `#L${range[0]}`
      : `#L${range[0]}-L${range[1]}`;
  return (
    `${repo.origin}/${encodeSegment(repo.owner)}/${encodeSegment(repo.repo)}` +
    `/blob/${repo.ref.split("/").map(encodeSegment).join("/")}` +
    `/${segments.map(encodeSegment).join("/")}${fragment}`
  );
}

/**
 * Untrusted text as a Markdown inline code span. Inside a span nothing is
 * interpreted, and the fence is one backtick longer than the longest run in
 * the text, so the text cannot close it.
 */
export function inlineCode(text: string): string {
  let clean = text.replace(CONTROL_RE_GLOBAL, " ").trim();
  if (clean.length > MAX_CODE_TEXT) clean = `${clean.slice(0, MAX_CODE_TEXT - 1)}…`;
  if (clean === "") clean = "?";
  let longest = 0;
  for (const run of clean.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  if (longest === 0) return `\`${clean}\``;
  const fence = "`".repeat(longest + 1);
  return `${fence} ${clean} ${fence}`;
}

function linkKey(link: DraftCodeLink): string {
  return JSON.stringify([link.filePath, link.startLine, link.endLine, link.symbolName]);
}

function renderLink(link: DraftCodeLink, repo: CodeLinkRepo | null): string {
  const range = lineRange(link);
  const where = !range
    ? link.filePath
    : range[0] === range[1]
      ? `${link.filePath}:${range[0]}`
      : `${link.filePath}:${range[0]}-${range[1]}`;
  const url = buildCodeLinkUrl(repo, link);
  const location = url ? `[${inlineCode(where)}](${url})` : inlineCode(where);
  if (!link.symbolName) return `- ${location}`;
  const kind = link.symbolKind && KIND_RE.test(link.symbolKind) ? ` (${link.symbolKind})` : "";
  return `- ${location} — ${inlineCode(link.symbolName)}${kind}`;
}

/**
 * The section's Markdown lines. Links are listed in the order given (the
 * loader's: highest confidence first), exact repeats once, and at most
 * {@link MAX_DRAFT_CODE_LINKS}; what is left out is counted in a closing line.
 */
export function renderCodeLinksSection(
  links: readonly DraftCodeLink[],
  repo: CodeLinkRepo | null,
): string[] {
  const seen = new Set<string>();
  const unique = links.filter((link) => {
    const key = linkKey(link);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) {
    return [`## Related code`, ``, `_METIS recorded no code links for this requirement._`];
  }
  const shown = unique.slice(0, MAX_DRAFT_CODE_LINKS);
  const hidden = unique.length - shown.length;
  return [
    `## Related code`,
    ``,
    `_Code METIS linked to this requirement. A starting point, not a complete list of what to change._`,
    ``,
    ...shown.map((link) => renderLink(link, repo)),
    ...(hidden > 0
      ? [
          ``,
          `_…and ${hidden} more linked location${hidden === 1 ? "" : "s"} not shown — the requirement in METIS lists all ${unique.length}._`,
        ]
      : []),
  ];
}

export interface DraftCodeLinks {
  repo: CodeLinkRepo | null;
  byRequirement: Map<string, DraftCodeLink[]>;
}

/**
 * The persisted code links of a draft run's requirements, in two queries.
 * Ordered so the same rows always render the same body (the body is hashed to
 * decide whether a published issue changed). Returns `null` when the links
 * could not be read: the draft is then generated without the section rather
 * than failing, or claiming a requirement has no links.
 */
export async function loadDraftCodeLinks(
  projectId: string,
  requirementIds: readonly string[],
): Promise<DraftCodeLinks | null> {
  try {
    const [rows, connectors] = await Promise.all([
      prisma.requirementCodeMapping.findMany({
        where: { projectId, requirementId: { in: [...requirementIds] } },
        select: {
          requirementId: true,
          filePath: true,
          startLine: true,
          endLine: true,
          codeSymbol: { select: { name: true, kind: true } },
        },
        orderBy: [{ confidence: "desc" }, { filePath: "asc" }, { startLine: "asc" }, { id: "asc" }],
      }),
      prisma.repoConnection.findMany({
        where: {
          projectId,
          deletedAt: null,
          provider: { in: ["github", "github_enterprise"] },
        },
        select: {
          provider: true,
          ownerOrOrg: true,
          repoName: true,
          defaultBranch: true,
          apiBaseUrl: true,
          lastCommitSha: true,
        },
      }),
    ]);
    const byRequirement = new Map<string, DraftCodeLink[]>();
    for (const row of rows) {
      const list = byRequirement.get(row.requirementId) ?? [];
      list.push({
        filePath: row.filePath,
        startLine: row.startLine,
        endLine: row.endLine,
        symbolName: row.codeSymbol?.name ?? null,
        symbolKind: row.codeSymbol?.kind ?? null,
      });
      byRequirement.set(row.requirementId, list);
    }
    return { repo: selectCodeLinkRepo(connectors), byRequirement };
  } catch (err) {
    log.warn("could not read code links; drafts are generated without them", {
      projectId,
      error: (err as Error).message,
    });
    return null;
  }
}
