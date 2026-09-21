/**
 * `pnpm --filter server agents-md:write -- --project <id> [--out <path>]`
 *
 * Reads the project + its documents from Prisma, renders an AGENTS.md, and
 * writes it to the requested path (default `./AGENTS.md`). When the project
 * has been marked `manual: true` (via `metadata.manualAgentsMd`), the file is
 * left untouched — see issue #123 acceptance criterion 4.
 */
/* eslint-disable no-console */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { prisma } from "../prisma.js";
import { buildAgentsMd } from "./build-agents-md.js";

/** Resolve the primary repo URL from the project's primary RepoConnection. */
async function resolvePrimaryRepoUrl(projectId: string): Promise<string | undefined> {
  const primary = await prisma.repoConnection.findFirst({
    where: { projectId, isPrimary: true, deletedAt: null },
  });
  if (!primary) return undefined;
  const baseUrl = primary.apiBaseUrl
    ? primary.apiBaseUrl.replace(/\/api\/v3\/?$/, "")
    : "https://github.com";
  return `${baseUrl}/${primary.ownerOrOrg}/${primary.repoName}`;
}

interface CliArgs {
  projectId: string;
  out: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let projectId = "";
  let out = path.resolve(process.cwd(), "AGENTS.md");
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--project" && args[i + 1]) {
      projectId = args[i + 1];
      i += 1;
    } else if (a === "--out" && args[i + 1]) {
      out = path.resolve(args[i + 1]);
      i += 1;
    }
  }
  if (!projectId) {
    throw new Error("--project <id> is required");
  }
  return { projectId, out };
}

async function main(): Promise<void> {
  const { projectId, out } = parseArgs(process.argv);

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { documents: { take: 50, orderBy: { uploadedAt: "desc" } } },
  });

  if (existsSync(out)) {
    const existing = await readFile(out, "utf8");
    if (existing.includes("manual: true")) {
      console.warn(`AGENTS.md at ${out} is marked manual:true — refusing to overwrite`);
      return;
    }
  }

  const result = buildAgentsMd({
    project: {
      id: project.id,
      name: project.name,
      description: project.description || undefined,
      repoUrl: await resolvePrimaryRepoUrl(project.id),
    },
    documents: project.documents.map((d) => ({
      id: d.id,
      name: d.filename,
    })),
  });

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, result.content, "utf8");
  console.log(
    `Wrote AGENTS.md (${result.bytes} bytes${result.truncated ? ", truncated" : ""}) to ${out}`,
  );
}

main()
  .catch((err) => {
    console.error("agents-md write failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
