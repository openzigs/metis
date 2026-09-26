/**
 * Epic #129 — the agents-and-skills fixture the real-SQLite route tests share:
 * two users, one legacy-open project, library skills (one disabled for the
 * project), a library "lead" agent that carries a skill and may delegate, and
 * custom agents the project may call. Rows are written with the production
 * Prisma client into a database built by the real migration chain.
 */
import type { PrismaClient } from "@prisma/client";

export const IDS = {
  alice: "u-alice",
  bob: "u-bob",
  project: "p-1",
  otherProject: "p-2",
  lead: "a-lead",
  helper: "c-helper",
  writer: "c-writer",
  outsider: "c-outsider",
} as const;

/** Five skills; bodies carry markers a test looks for (they must NOT reach a prompt unasked). */
export const SKILLS = [
  {
    id: "s-style",
    key: "style-guide",
    name: "Style guide",
    description: "House writing rules. Use for any prose.",
  },
  { id: "s-tone", key: "tone", name: "Tone", description: "Voice and tone for customer text." },
  {
    id: "s-release",
    key: "release-notes",
    name: "Release notes",
    description: "How to draft release notes.",
  },
  {
    id: "s-sql",
    key: "sql-review",
    name: "SQL review",
    description: "Checklist for reviewing SQL.",
  },
  {
    id: "s-blocked",
    key: "blocked-skill",
    name: "Blocked skill",
    description: "Disabled for the project.",
  },
] as const;

export const bodyMarker = (key: string): string => `BODY-MARKER-${key}-${"x".repeat(400)}`;

export async function seedAgentsFixture(db: PrismaClient): Promise<void> {
  for (const id of [IDS.alice, IDS.bob]) {
    await db.user.create({
      data: { id, username: id, displayName: id, email: `${id}@example.test` },
    });
  }
  for (const id of [IDS.project, IDS.otherProject]) {
    await db.project.create({ data: { id, name: id, slug: id, createdById: IDS.alice } });
  }
  for (const s of SKILLS) {
    await db.skill.create({
      data: {
        id: s.id,
        key: s.key,
        name: s.name,
        description: s.description,
        version: "1.0.0",
        instructions: bodyMarker(s.key),
      },
    });
  }
  await db.skillFile.create({
    data: {
      skillId: "s-release",
      path: "references/TEMPLATE.md",
      content: "TEMPLATE-FILE-MARKER",
      sizeBytes: 20,
      sha256: "0".repeat(64),
    },
  });
  // The project's skill allow-list is exhaustive once it has rows: every skill
  // but `blocked-skill` is enabled for it.
  for (const s of SKILLS) {
    await db.projectSkillAllowlist.create({
      data: { projectId: IDS.project, skillId: s.id, enabled: s.key !== "blocked-skill" },
    });
  }
  await db.agent.create({
    data: {
      id: IDS.lead,
      key: "lead",
      name: "lead",
      displayName: "Lead",
      description: "Leads.",
      systemPrompt: "You are the lead.",
      tools: JSON.stringify(["count_rows", "danger_write", "agent:*"]),
      version: "1.0.0",
      skills: { create: [{ skillId: "s-style" }] },
    },
  });
  await db.customAgent.create({
    data: {
      id: IDS.helper,
      projectId: IDS.project,
      name: "Helper",
      description: "Counts rows for you.",
      systemPrompt: "You are the helper.",
      // NOT danger_write: the caller has it, this agent may not use it.
      tools: JSON.stringify(["count_rows"]),
      skillKeys: JSON.stringify(["release-notes"]),
    },
  });
  await db.customAgent.create({
    data: {
      id: IDS.writer,
      projectId: IDS.project,
      name: "Writer",
      description: "Writes rows.",
      systemPrompt: "You are the writer.",
      tools: JSON.stringify(["danger_write", "agent:*"]),
    },
  });
  // Another project's agent: never callable from this project.
  await db.customAgent.create({
    data: {
      id: IDS.outsider,
      projectId: IDS.otherProject,
      name: "Outsider",
      description: "Belongs elsewhere.",
      systemPrompt: "You are elsewhere.",
      tools: "[]",
    },
  });
}
