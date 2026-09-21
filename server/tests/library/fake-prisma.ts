/**
 * Tiny in-memory Prisma stand-in used by Phase 10 library tests.
 *
 * Implements just enough of the model surface the library + runtime + route
 * code touches: skill, skillVersion, agent, agentVersion, agentSkill,
 * projectSkillAllowlist, projectAgentAllowlist, project, aISession, auditLog.
 *
 * The fake mirrors Prisma's call semantics close enough for the unit tests \u2014
 * relations are followed when `include` is requested, soft-delete fields are
 * respected, and `$transaction` falls through synchronously.
 */
import { vi } from "vitest";

type AnyRow = Record<string, unknown>;

let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

interface SkillRow {
  id: string;
  key: string;
  name: string;
  description: string;
  version: string;
  instructions: string;
  tools: string;
  resources: string;
  tags: string;
  manifest: string;
  contentSha256: string | null;
  source: string;
  enabled: boolean;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  deletedAt: Date | null;
}
interface SkillVersionRow {
  id: string;
  skillId: string;
  version: string;
  manifest: string;
  instructions: string;
  contentSha256: string;
  createdById: string | null;
  createdAt: Date;
}
interface AgentRow {
  id: string;
  key: string;
  name: string;
  displayName: string;
  description: string;
  model: string;
  systemPrompt: string;
  tools: string;
  tags: string;
  handoffs: string;
  manifest: string;
  contentSha256: string | null;
  source: string;
  enabled: boolean;
  version: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  deletedAt: Date | null;
}
interface AgentVersionRow {
  id: string;
  agentId: string;
  version: string;
  manifest: string;
  systemPrompt: string;
  contentSha256: string;
  createdById: string | null;
  createdAt: Date;
}
interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdById: string;
  createdAt: Date;
  deletedAt: Date | null;
}
interface AISessionRow {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  provider: string;
  model: string;
  policy: string;
  status: string;
  providerSecretRef: string | null;
  copilotHome: string | null;
  agentId: string | null;
  agentSnapshot: string | null;
  loadedSkillIds: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
type AuditRow = AnyRow;

interface AgentSkillRow {
  agentId: string;
  skillId: string;
}
interface ProjectSkillAllow {
  projectId: string;
  skillId: string;
  enabled: boolean;
  addedById: string | null;
  createdAt: Date;
}
interface ProjectAgentAllow {
  projectId: string;
  agentId: string;
  enabled: boolean;
  addedById: string | null;
  createdAt: Date;
}

export interface FakeStore {
  skills: SkillRow[];
  skillVersions: SkillVersionRow[];
  agents: AgentRow[];
  agentVersions: AgentVersionRow[];
  agentSkills: AgentSkillRow[];
  projects: ProjectRow[];
  aiSessions: AISessionRow[];
  audit: AuditRow[];
  projectSkillAllow: ProjectSkillAllow[];
  projectAgentAllow: ProjectAgentAllow[];
}

const store: FakeStore = {
  skills: [],
  skillVersions: [],
  agents: [],
  agentVersions: [],
  agentSkills: [],
  projects: [],
  aiSessions: [],
  audit: [],
  projectSkillAllow: [],
  projectAgentAllow: [],
};

export function getStore(): FakeStore {
  return store;
}

export function resetStore(): void {
  store.skills.length = 0;
  store.skillVersions.length = 0;
  store.agents.length = 0;
  store.agentVersions.length = 0;
  store.agentSkills.length = 0;
  store.projects.length = 0;
  store.aiSessions.length = 0;
  store.audit.length = 0;
  store.projectSkillAllow.length = 0;
  store.projectAgentAllow.length = 0;
  counter = 0;
}

function _matchString(field: string | null | undefined, criterion: unknown): boolean {
  if (criterion === undefined) return true;
  if (criterion === null) return field === null || field === undefined;
  if (typeof criterion === "string") return field === criterion;
  if (typeof criterion === "object" && criterion) {
    const c = criterion as { contains?: string; in?: string[]; equals?: string };
    if (
      c.contains !== undefined &&
      (field ?? "").toString().toLowerCase().includes(c.contains.toLowerCase())
    )
      return true;
    if (c.in && c.in.includes(field as string)) return true;
    if (c.equals !== undefined) return field === c.equals;
    if (c.contains === undefined && c.in === undefined && c.equals === undefined) return true;
    return false;
  }
  return false;
}

function matchWhere<T extends AnyRow>(row: T, where: AnyRow | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "AND") {
      const arr = Array.isArray(v) ? v : [v];
      if (!arr.every((c) => matchWhere(row, c as AnyRow))) return false;
      continue;
    }
    if (k === "OR") {
      const arr = Array.isArray(v) ? v : [v];
      if (!arr.some((c) => matchWhere(row, c as AnyRow))) return false;
      continue;
    }
    if (v === null) {
      if ((row as AnyRow)[k] !== null) return false;
      continue;
    }
    if (typeof v === "object" && v) {
      const cobj = v as { contains?: string; in?: unknown[]; equals?: unknown };
      const value = (row as AnyRow)[k];
      if (cobj.contains !== undefined) {
        if (typeof value !== "string" || !value.toLowerCase().includes(cobj.contains.toLowerCase()))
          return false;
        continue;
      }
      if (cobj.in !== undefined) {
        if (!cobj.in.includes(value)) return false;
        continue;
      }
      if (cobj.equals !== undefined) {
        if (value !== cobj.equals) return false;
        continue;
      }
    } else if ((row as AnyRow)[k] !== v) {
      return false;
    }
  }
  return true;
}

function sortRows<T extends AnyRow>(rows: T[], orderBy: AnyRow | undefined): T[] {
  if (!orderBy) return rows;
  const [key, dir] = Object.entries(orderBy)[0];
  return [...rows].sort((a, b) => {
    const av = (a as AnyRow)[key];
    const bv = (b as AnyRow)[key];
    if (av instanceof Date && bv instanceof Date) {
      return dir === "asc" ? av.getTime() - bv.getTime() : bv.getTime() - av.getTime();
    }
    if (av === bv) return 0;
    return dir === "asc" ? (av! < bv! ? -1 : 1) : av! < bv! ? 1 : -1;
  });
}

function applyData<T extends AnyRow>(row: T, data: AnyRow): T {
  const out = { ...row };
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (k === "createdBy") {
      const conn = v as { connect?: { id: string } } | null;
      if (conn?.connect) out.createdById = conn.connect.id;
      else if (conn === null) out.createdById = null;
      continue;
    }
    if (k === "versions") continue; // handled by callers
    if (k === "skills") continue; // handled by callers
    out[k] = v as never;
  }
  out.updatedAt = new Date();
  return out;
}

function withInclude<T extends AnyRow>(
  row: T,
  include: AnyRow | undefined,
  kind: "skill" | "agent",
): T {
  if (!include) return row;
  const out = { ...row } as AnyRow;
  if (include.versions && kind === "skill") {
    out.versions = store.skillVersions.filter((v) => v.skillId === row.id);
  }
  if (include.versions && kind === "agent") {
    out.versions = store.agentVersions.filter((v) => v.agentId === row.id);
  }
  if (include.skills && kind === "agent") {
    const links = store.agentSkills.filter((s) => s.agentId === row.id);
    const skillInc = (include.skills as AnyRow).include as AnyRow | undefined;
    out.skills = links.map((l) => {
      const skill = store.skills.find((s) => s.id === l.skillId);
      if (!skillInc?.skill) return { agentId: l.agentId, skillId: l.skillId };
      return { agentId: l.agentId, skillId: l.skillId, skill: { key: skill?.key } };
    });
  }
  return out as T;
}

function makeSkillModel() {
  return {
    findMany: vi.fn(async (args?: { where?: AnyRow; orderBy?: AnyRow; select?: AnyRow }) => {
      const filtered = store.skills.filter((r) => matchWhere(r, args?.where));
      const sorted = sortRows(filtered, args?.orderBy);
      if (args?.select) {
        return sorted.map((r) => {
          const out: AnyRow = {};
          for (const k of Object.keys(args.select!)) out[k] = (r as AnyRow)[k];
          return out;
        });
      }
      return sorted;
    }),
    findUnique: vi.fn(async (args: { where: { id?: string; key?: string }; include?: AnyRow }) => {
      const row = store.skills.find((r) =>
        args.where.id ? r.id === args.where.id : r.key === args.where.key,
      );
      if (!row) return null;
      return withInclude(row, args.include, "skill");
    }),
    findFirst: vi.fn(async (args?: { where?: AnyRow; include?: AnyRow }) => {
      const row = store.skills.find((r) => matchWhere(r, args?.where));
      return row ? withInclude(row, args?.include, "skill") : null;
    }),
    create: vi.fn(async (args: { data: AnyRow }) => {
      const now = new Date();
      const row: SkillRow = {
        id: id("skill"),
        key: String(args.data.key),
        name: String(args.data.name ?? ""),
        description: String(args.data.description ?? ""),
        version: String(args.data.version ?? "0.1.0"),
        instructions: String(args.data.instructions ?? ""),
        tools: String(args.data.tools ?? "[]"),
        resources: String(args.data.resources ?? "[]"),
        tags: String(args.data.tags ?? "[]"),
        manifest: String(args.data.manifest ?? "{}"),
        contentSha256: (args.data.contentSha256 as string | null | undefined) ?? null,
        source: String(args.data.source ?? "inline"),
        enabled: args.data.enabled === undefined ? true : Boolean(args.data.enabled),
        createdById: ((args.data.createdBy as { connect?: { id: string } } | undefined)?.connect
          ?.id ?? null) as string | null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
      };
      store.skills.push(row);
      const versions = (args.data.versions as { create?: AnyRow } | undefined)?.create;
      if (versions) {
        store.skillVersions.push({
          id: id("skillv"),
          skillId: row.id,
          version: String(versions.version),
          manifest: String(versions.manifest ?? "{}"),
          instructions: String(versions.instructions ?? ""),
          contentSha256: String(versions.contentSha256 ?? ""),
          createdById: ((versions.createdBy as { connect?: { id: string } } | undefined)?.connect
            ?.id ?? null) as string | null,
          createdAt: now,
        });
      }
      return row;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: AnyRow; include?: AnyRow }) => {
      const idx = store.skills.findIndex((r) => r.id === args.where.id);
      if (idx === -1) throw new Error("not found");
      store.skills[idx] = applyData(store.skills[idx], args.data);
      const newV = (args.data.versions as { create?: AnyRow } | undefined)?.create;
      if (newV) {
        store.skillVersions.push({
          id: id("skillv"),
          skillId: store.skills[idx].id,
          version: String(newV.version),
          manifest: String(newV.manifest ?? "{}"),
          instructions: String(newV.instructions ?? ""),
          contentSha256: String(newV.contentSha256 ?? ""),
          createdById: ((newV.createdBy as { connect?: { id: string } } | undefined)?.connect?.id ??
            null) as string | null,
          createdAt: new Date(),
        });
      }
      return withInclude(store.skills[idx], args.include, "skill");
    }),
  };
}

function makeAgentModel() {
  return {
    findMany: vi.fn(
      async (args?: { where?: AnyRow; orderBy?: AnyRow; include?: AnyRow; select?: AnyRow }) => {
        const filtered = store.agents.filter((r) => matchWhere(r, args?.where));
        const sorted = sortRows(filtered, args?.orderBy);
        if (args?.select) {
          return sorted.map((r) => {
            const out: AnyRow = {};
            for (const k of Object.keys(args.select!)) out[k] = (r as AnyRow)[k];
            return out;
          });
        }
        return sorted.map((r) => withInclude(r, args?.include, "agent"));
      },
    ),
    findUnique: vi.fn(async (args: { where: { id?: string; key?: string }; include?: AnyRow }) => {
      const row = store.agents.find((r) =>
        args.where.id ? r.id === args.where.id : r.key === args.where.key,
      );
      if (!row) return null;
      return withInclude(row, args.include, "agent");
    }),
    create: vi.fn(async (args: { data: AnyRow; include?: AnyRow }) => {
      const now = new Date();
      const row: AgentRow = {
        id: id("agent"),
        key: String(args.data.key),
        name: String(args.data.name ?? ""),
        displayName: String(args.data.displayName ?? ""),
        description: String(args.data.description ?? ""),
        model: String(args.data.model ?? ""),
        systemPrompt: String(args.data.systemPrompt ?? ""),
        tools: String(args.data.tools ?? "[]"),
        tags: String(args.data.tags ?? "[]"),
        handoffs: String(args.data.handoffs ?? "[]"),
        manifest: String(args.data.manifest ?? "{}"),
        contentSha256: (args.data.contentSha256 as string | null | undefined) ?? null,
        source: String(args.data.source ?? "inline"),
        enabled: args.data.enabled === undefined ? true : Boolean(args.data.enabled),
        version: String(args.data.version ?? "0.1.0"),
        createdById: ((args.data.createdBy as { connect?: { id: string } } | undefined)?.connect
          ?.id ?? null) as string | null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
      };
      store.agents.push(row);
      const versions = (args.data.versions as { create?: AnyRow } | undefined)?.create;
      if (versions) {
        store.agentVersions.push({
          id: id("agentv"),
          agentId: row.id,
          version: String(versions.version),
          manifest: String(versions.manifest ?? "{}"),
          systemPrompt: String(versions.systemPrompt ?? ""),
          contentSha256: String(versions.contentSha256 ?? ""),
          createdById: ((versions.createdBy as { connect?: { id: string } } | undefined)?.connect
            ?.id ?? null) as string | null,
          createdAt: now,
        });
      }
      const skillsCreate = (
        args.data.skills as { create?: Array<{ skill: { connect: { id: string } } }> } | undefined
      )?.create;
      if (skillsCreate) {
        for (const link of skillsCreate) {
          store.agentSkills.push({ agentId: row.id, skillId: link.skill.connect.id });
        }
      }
      return withInclude(row, args.include, "agent");
    }),
    update: vi.fn(async (args: { where: { id: string }; data: AnyRow; include?: AnyRow }) => {
      const idx = store.agents.findIndex((r) => r.id === args.where.id);
      if (idx === -1) throw new Error("not found");
      store.agents[idx] = applyData(store.agents[idx], args.data);
      const newV = (args.data.versions as { create?: AnyRow } | undefined)?.create;
      if (newV) {
        store.agentVersions.push({
          id: id("agentv"),
          agentId: store.agents[idx].id,
          version: String(newV.version),
          manifest: String(newV.manifest ?? "{}"),
          systemPrompt: String(newV.systemPrompt ?? ""),
          contentSha256: String(newV.contentSha256 ?? ""),
          createdById: ((newV.createdBy as { connect?: { id: string } } | undefined)?.connect?.id ??
            null) as string | null,
          createdAt: new Date(),
        });
      }
      const skillsCreate = (
        args.data.skills as { create?: Array<{ skill: { connect: { id: string } } }> } | undefined
      )?.create;
      if (skillsCreate) {
        for (const link of skillsCreate) {
          store.agentSkills.push({ agentId: store.agents[idx].id, skillId: link.skill.connect.id });
        }
      }
      return withInclude(store.agents[idx], args.include, "agent");
    }),
  };
}

function makeAuditModel() {
  return {
    create: vi.fn(async ({ data }: { data: AnyRow }) => {
      const row = { ...data, id: id("audit"), ts: new Date() };
      store.audit.push(row);
      return row;
    }),
  };
}

const fake = {
  $transaction: vi.fn(async (fn: (tx: typeof fake) => Promise<unknown>) => fn(fake)),
  workspaceMember: {
    findMany: vi.fn(async () => []),
  },
  user: {
    upsert: vi.fn(
      async ({
        create,
      }: {
        create: { username: string; displayName?: string; email?: string };
      }) => ({
        id: `user_${create.username}`,
        username: create.username,
        displayName: create.displayName ?? create.username,
        email: create.email ?? `${create.username}@test.local`,
        status: "active",
        lastLoginAt: new Date(),
      }),
    ),
  },
  userRole: {
    findFirst: vi.fn(async () => null),
  },
  skill: makeSkillModel(),
  skillVersion: {
    findMany: vi.fn(async (args: { where: AnyRow; orderBy?: AnyRow }) => {
      const rows = store.skillVersions.filter((r) => matchWhere(r, args.where));
      return sortRows(rows, args.orderBy);
    }),
    findFirst: vi.fn(
      async (args: { where: AnyRow }) =>
        store.skillVersions.find((r) => matchWhere(r, args.where)) ?? null,
    ),
  },
  agent: makeAgentModel(),
  agentVersion: {
    findMany: vi.fn(async (args: { where: AnyRow; orderBy?: AnyRow }) => {
      const rows = store.agentVersions.filter((r) => matchWhere(r, args.where));
      return sortRows(rows, args.orderBy);
    }),
    findFirst: vi.fn(
      async (args: { where: AnyRow }) =>
        store.agentVersions.find((r) => matchWhere(r, args.where)) ?? null,
    ),
  },
  agentSkill: {
    deleteMany: vi.fn(async (args: { where: { agentId: string } }) => {
      const before = store.agentSkills.length;
      for (let i = store.agentSkills.length - 1; i >= 0; i -= 1) {
        if (store.agentSkills[i].agentId === args.where.agentId) {
          store.agentSkills.splice(i, 1);
        }
      }
      return { count: before - store.agentSkills.length };
    }),
  },
  projectSkillAllowlist: {
    findMany: vi.fn(async (args: { where: { projectId: string }; include?: AnyRow }) => {
      const rows = store.projectSkillAllow.filter((r) => r.projectId === args.where.projectId);
      if (args.include?.skill) {
        return rows.map((r) => ({
          ...r,
          skill: { key: store.skills.find((s) => s.id === r.skillId)?.key ?? "" },
        }));
      }
      return rows;
    }),
    upsert: vi.fn(
      async (args: {
        where: { projectId_skillId: { projectId: string; skillId: string } };
        create: ProjectSkillAllow;
        update: { enabled: boolean };
      }) => {
        const existing = store.projectSkillAllow.find(
          (r) =>
            r.projectId === args.where.projectId_skillId.projectId &&
            r.skillId === args.where.projectId_skillId.skillId,
        );
        if (existing) {
          existing.enabled = args.update.enabled;
          return existing;
        }
        const row: ProjectSkillAllow = {
          ...args.create,
          createdAt: args.create.createdAt ?? new Date(),
        };
        store.projectSkillAllow.push(row);
        return row;
      },
    ),
    deleteMany: vi.fn(async (args: { where: { projectId: string; skillId: string } }) => {
      const before = store.projectSkillAllow.length;
      for (let i = store.projectSkillAllow.length - 1; i >= 0; i -= 1) {
        const r = store.projectSkillAllow[i];
        if (r.projectId === args.where.projectId && r.skillId === args.where.skillId) {
          store.projectSkillAllow.splice(i, 1);
        }
      }
      return { count: before - store.projectSkillAllow.length };
    }),
  },
  projectAgentAllowlist: {
    findMany: vi.fn(async (args: { where: { projectId: string }; include?: AnyRow }) => {
      const rows = store.projectAgentAllow.filter((r) => r.projectId === args.where.projectId);
      if (args.include?.agent) {
        return rows.map((r) => ({
          ...r,
          agent: { key: store.agents.find((a) => a.id === r.agentId)?.key ?? "" },
        }));
      }
      return rows;
    }),
    upsert: vi.fn(
      async (args: {
        where: { projectId_agentId: { projectId: string; agentId: string } };
        create: ProjectAgentAllow;
        update: { enabled: boolean };
      }) => {
        const existing = store.projectAgentAllow.find(
          (r) =>
            r.projectId === args.where.projectId_agentId.projectId &&
            r.agentId === args.where.projectId_agentId.agentId,
        );
        if (existing) {
          existing.enabled = args.update.enabled;
          return existing;
        }
        const row: ProjectAgentAllow = {
          ...args.create,
          createdAt: args.create.createdAt ?? new Date(),
        };
        store.projectAgentAllow.push(row);
        return row;
      },
    ),
    deleteMany: vi.fn(async (args: { where: { projectId: string; agentId: string } }) => {
      const before = store.projectAgentAllow.length;
      for (let i = store.projectAgentAllow.length - 1; i >= 0; i -= 1) {
        const r = store.projectAgentAllow[i];
        if (r.projectId === args.where.projectId && r.agentId === args.where.agentId) {
          store.projectAgentAllow.splice(i, 1);
        }
      }
      return { count: before - store.projectAgentAllow.length };
    }),
  },
  project: {
    findFirst: vi.fn(
      async (args: { where: AnyRow }) =>
        store.projects.find((r) => matchWhere(r, args.where)) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: AnyRow }) => {
      const row: ProjectRow = {
        id: id("project"),
        name: String(data.name ?? "Project"),
        slug: String(data.slug ?? "project"),
        status: String(data.status ?? "active"),
        createdById: String(data.createdById ?? "user"),
        createdAt: new Date(),
        deletedAt: null,
      };
      store.projects.push(row);
      return row;
    }),
  },
  aISession: {
    findFirst: vi.fn(
      async (args: { where: AnyRow }) =>
        store.aiSessions.find((r) => matchWhere(r, args.where)) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: AnyRow }) => {
      const row: AISessionRow = {
        id: id("session"),
        userId: String(data.userId),
        projectId: (data.projectId as string | null) ?? null,
        title: String(data.title ?? "New Chat"),
        provider: String(data.provider ?? "offline-stub"),
        model: String(data.model ?? "gpt"),
        policy: String(data.policy ?? "{}"),
        status: "active",
        providerSecretRef: (data.providerSecretRef as string | null) ?? null,
        copilotHome: null,
        agentId: (data.agentId as string | null) ?? null,
        agentSnapshot: (data.agentSnapshot as string | null) ?? null,
        loadedSkillIds: String(data.loadedSkillIds ?? "[]"),
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };
      store.aiSessions.push(row);
      return row;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: AnyRow }) => {
      const idx = store.aiSessions.findIndex((r) => r.id === args.where.id);
      if (idx === -1) throw new Error("session not found");
      store.aiSessions[idx] = { ...store.aiSessions[idx], ...args.data, updatedAt: new Date() };
      return store.aiSessions[idx];
    }),
  },
  auditLog: makeAuditModel(),
};

export type FakePrisma = typeof fake;
export const fakePrisma: FakePrisma = fake;

/**
 * Stub ToolRegistry used by AgentService tests so the new tool-ref
 * validator (issue #74) accepts the canonical fixture tools without each
 * spec having to register them. Wildcards `mcp:github:*` resolve via the
 * registered tool prefix derivation in AgentService.validateToolRefs.
 */
export const stubAgentToolRegistry = () =>
  ({
    list: () => [
      { name: "github", description: "stub", risk: "low" as const },
      { name: "mcp:github:create_issue", description: "stub", risk: "low" as const },
    ],
  }) as unknown as import("../../src/lib/ai/tool-registry.js").ToolRegistry;
