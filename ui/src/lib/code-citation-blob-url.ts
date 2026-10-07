/**
 * #728 — turn a finding's code citation (`filePath:startLine-endLine`) into a
 * link to the file on GitHub (or GitHub Enterprise) at the repo connector's ref.
 *
 * Everything here is pure and defensive: a citation path comes from model output
 * grounded on the code graph, so anything that is not a plain repository-relative
 * path (`..`, absolute, a URL / `javascript:` scheme, backslashes, control
 * characters) is refused and the caller keeps rendering plain text. Each path and
 * ref segment is URL-encoded, and the origin is only ever `https://github.com` or
 * the https origin of the connector's configured Enterprise base URL — so the
 * result can never be an open redirect or a script URL.
 *
 * The citation's path is used as-is: code-graph paths are already
 * repository-relative. The `src/` stripping from #717 applies to the ingester's
 * document *keys* (`connector:repo:<id>:src/<path>`), not to these paths, where a
 * leading `src/` is a real directory.
 */
import type { RepoConnector } from "@metis/shared";
import type { AnalysisCodeCitation } from "@/lib/analysis-api";

/** Where a citation's file lives on the web: origin + owner/repo at a ref. */
export interface CodeCitationRepo {
  /** `https://github.com` or a GitHub Enterprise https origin. */
  origin: string;
  owner: string;
  repo: string;
  /** Commit SHA when known, else the connector's branch / tag. */
  ref: string;
}

export type CodeCitationRepoSource = Pick<
  RepoConnector,
  "provider" | "ownerOrOrg" | "repoName" | "defaultBranch" | "apiBaseUrl" | "lastCommitSha"
> & { deletedAt?: RepoConnector["deletedAt"] | string | null };

const GITHUB_ORIGIN = "https://github.com";
const SHA_RE = /^[0-9a-f]{7,64}$/i;
// Same shape the shared connector schema enforces for owner / repo / branch.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * The web origin a GitHub connector's files are browsable at, or `null` when it
 * cannot be known safely (non-GitHub provider, Enterprise without a base URL,
 * non-https or unparseable base URL).
 */
export function githubWebOrigin(provider: string, apiBaseUrl: string | null): string | null {
  if (provider !== "github" && provider !== "github_enterprise") return null;
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
 * The repo a project's code citations point into: its single, non-deleted
 * GitHub / GitHub Enterprise connector. Citations carry no connector id, so with
 * zero or several such connectors the target is ambiguous and this is `null`.
 */
export function selectCodeCitationRepo(
  connectors: readonly CodeCitationRepoSource[] | null | undefined,
): CodeCitationRepo | null {
  if (!Array.isArray(connectors)) return null;
  const github = connectors.filter(
    (c): c is CodeCitationRepoSource =>
      Boolean(c) && (c.provider === "github" || c.provider === "github_enterprise") && !c.deletedAt,
  );
  if (github.length !== 1) return null;
  const c = github[0];
  const origin = githubWebOrigin(c.provider, c.apiBaseUrl ?? null);
  const owner = c.ownerOrOrg ?? "";
  const repo = c.repoName ?? "";
  if (!origin || !NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;
  const sha = c.lastCommitSha?.trim();
  const ref = sha && SHA_RE.test(sha) ? sha : c.defaultBranch;
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

function lineFragment(startLine: number, endLine: number): string {
  if (!Number.isInteger(startLine) || startLine < 1) return "";
  if (!Number.isInteger(endLine) || endLine <= startLine) return `#L${startLine}`;
  return `#L${startLine}-L${endLine}`;
}

/**
 * `https://<host>/<owner>/<repo>/blob/<ref>/<path>#L<start>-L<end>` (single
 * line: `#L<n>`), or `null` when there is no repo or the path is unsafe.
 */
export function buildCodeCitationBlobUrl(
  repo: CodeCitationRepo | null | undefined,
  citation: Pick<AnalysisCodeCitation, "filePath" | "startLine" | "endLine">,
): string | null {
  if (!repo) return null;
  const segments = safePathSegments(citation.filePath);
  if (!segments) return null;
  const enc = (parts: string[]) => parts.map(encodeURIComponent).join("/");
  return (
    `${repo.origin}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}` +
    `/blob/${enc(repo.ref.split("/"))}/${enc(segments)}` +
    lineFragment(citation.startLine, citation.endLine)
  );
}
