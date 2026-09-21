/**
 * Combined library search across Skills + Agents.
 *
 * Used by the `/library` browse page. Search input is parameterised through
 * Prisma (no string concatenation, no SQL injection vector). When a `tag`
 * filter is supplied we apply it post-fetch because tags are persisted as a
 * JSON-encoded array (sqlite has no array operators we can rely on across
 * both engines).
 */
import { getAgentService, type AgentSummary } from "./agent-service.js";
import { getSkillService, type SkillSummary } from "./skill-service.js";

export interface LibrarySearchHit {
  kind: "skill" | "agent";
  id: string;
  key: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
  enabled: boolean;
  archived: boolean;
  updatedAt: Date;
}

export interface LibrarySearchOptions {
  query?: string;
  tag?: string;
  kinds?: Array<"skill" | "agent">;
  includeArchived?: boolean;
}

function summariseSkill(s: SkillSummary): LibrarySearchHit {
  return {
    kind: "skill",
    id: s.id,
    key: s.key,
    name: s.name,
    description: s.description,
    version: s.version,
    tags: s.tags,
    enabled: s.enabled,
    archived: s.archived,
    updatedAt: s.updatedAt,
  };
}

function summariseAgent(a: AgentSummary): LibrarySearchHit {
  return {
    kind: "agent",
    id: a.id,
    key: a.key,
    name: a.displayName || a.name,
    description: a.description,
    version: a.version,
    tags: a.tags,
    enabled: a.enabled,
    archived: a.archived,
    updatedAt: a.updatedAt,
  };
}

export async function searchLibrary(opts: LibrarySearchOptions = {}): Promise<LibrarySearchHit[]> {
  const kinds =
    opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : new Set(["skill", "agent"]);
  const out: LibrarySearchHit[] = [];
  if (kinds.has("skill")) {
    const rows = await getSkillService().list({
      query: opts.query,
      tag: opts.tag,
      includeArchived: opts.includeArchived,
    });
    out.push(...rows.map(summariseSkill));
  }
  if (kinds.has("agent")) {
    const rows = await getAgentService().list({
      query: opts.query,
      tag: opts.tag,
      includeArchived: opts.includeArchived,
    });
    out.push(...rows.map(summariseAgent));
  }
  out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return out;
}
