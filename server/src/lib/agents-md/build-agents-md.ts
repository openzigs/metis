/**
 * Build a deterministic AGENTS.md document for a METIS project.
 *
 * Output structure:
 *   # <project name>
 *   <description>
 *
 *   ## Project metadata
 *   - <key>: <value>...
 *
 *   ## Conventions
 *   - <bullet>...
 *
 *   ## Reference docs
 *   - [<doc.name>](#doc-<doc.id>) - <doc.summary>
 *
 *   <!-- generated-by: metis | hash: <sha256> -->
 *
 * The output is byte-stable for unchanged input. When the rendered string
 * exceeds `maxBytes` (default 8192), reference doc summaries are progressively
 * truncated and a warning marker is appended; LLM summarisation is intentionally
 * NOT performed (issue #123 acceptance criterion 3).
 */
import crypto from "node:crypto";

export interface AgentsMdProjectInput {
  id: string;
  name: string;
  description?: string;
  techStack?: readonly string[];
  conventions?: readonly string[];
  /** Primary repo URL derived from the primary RepoConnection. */
  repoUrl?: string;
  /** When true the consumer will not overwrite an existing AGENTS.md. */
  manual?: boolean;
}

export interface AgentsMdDocInput {
  id: string;
  name: string;
  summary?: string;
}

export interface BuildAgentsMdInput {
  project: AgentsMdProjectInput;
  documents?: readonly AgentsMdDocInput[];
  /** Default 8192 — Copilot's recommended ceiling for AGENTS.md. */
  maxBytes?: number;
}

export interface BuildAgentsMdOutput {
  content: string;
  hash: string;
  truncated: boolean;
  bytes: number;
}

const DEFAULT_MAX_BYTES = 8 * 1024;

export function buildAgentsMd(input: BuildAgentsMdInput): BuildAgentsMdOutput {
  const max = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const project = input.project;
  const docs = input.documents ?? [];

  const lines: string[] = [];
  lines.push(`# ${project.name}`);
  lines.push("");
  if (project.description) {
    lines.push(project.description.trim());
    lines.push("");
  }

  lines.push("## Project metadata");
  lines.push(`- id: ${project.id}`);
  if (project.repoUrl) {
    lines.push(`- repository: ${project.repoUrl}`);
  }
  if (project.techStack && project.techStack.length > 0) {
    lines.push(`- tech stack: ${project.techStack.join(", ")}`);
  }
  lines.push("");

  if (project.conventions && project.conventions.length > 0) {
    lines.push("## Conventions");
    for (const c of project.conventions) {
      lines.push(`- ${c.trim()}`);
    }
    lines.push("");
  }

  let truncated = false;

  if (docs.length > 0) {
    lines.push("## Reference docs");
    for (const doc of docs) {
      const summary = doc.summary ? ` — ${doc.summary.trim()}` : "";
      lines.push(`- [${doc.name}](#doc-${doc.id})${summary}`);
    }
    lines.push("");
  }

  let content = renderFooter(lines, project, false);

  if (Buffer.byteLength(content, "utf8") > max) {
    truncated = true;
    // Strategy: drop summaries first, then truncate the doc list.
    const trimmed = lines.map((line) => {
      if (line.startsWith("- [") && line.includes("](#doc-")) {
        const close = line.indexOf(")");
        return line.slice(0, close + 1);
      }
      return line;
    });
    content = renderFooter(trimmed, project, true);
    while (Buffer.byteLength(content, "utf8") > max && trimmed.length > 0) {
      // Drop the last reference doc bullet to bring us under the cap.
      const lastDocIdx = lastIndexOf(trimmed, (l) => l.startsWith("- [") && l.includes("](#doc-"));
      if (lastDocIdx === -1) break;
      trimmed.splice(lastDocIdx, 1);
      content = renderFooter(trimmed, project, true);
    }
  }

  const hash = crypto.createHash("sha256").update(content).digest("hex");
  return {
    content,
    hash,
    truncated,
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

function renderFooter(lines: string[], project: AgentsMdProjectInput, truncated: boolean): string {
  const trailing = [...lines];
  if (truncated) {
    trailing.push("");
    trailing.push("<!-- truncated: deterministic -->");
  }
  if (project.manual) {
    trailing.push("<!-- manual: true (regeneration disabled) -->");
  }
  trailing.push(`<!-- generated-by: metis project=${project.id} -->`);
  // Single trailing newline.
  return trailing.join("\n").replace(/\n+$/, "") + "\n";
}

function lastIndexOf<T>(arr: T[], predicate: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}
