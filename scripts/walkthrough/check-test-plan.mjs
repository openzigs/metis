#!/usr/bin/env node
/**
 * `pnpm walkthrough:check-plan` — fail when the walkthrough test plan names an
 * API route the server does not register or a UI page that has no `page.tsx`
 * (#948). Run it before a walkthrough starts; CI runs it on every PR so the plan
 * cannot rot between runs.
 *
 * Thin I/O glue: it reads the plan, the server's route sources and the list of
 * page files, and hands them to `../lib/walkthrough-plan-drift-core.mjs`, where
 * the rules and their reasoning live.
 *
 * Usage:
 *   node scripts/walkthrough/check-test-plan.mjs [--plan <path>] [--root <dir>]
 *
 * Exit codes:
 *   0  every checked reference resolves
 *   1  a dead reference, an unreadable plan, or a route walk that lost a mount
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectApiRoutes,
  extractPlanReferences,
  findPlanDrift,
} from "../lib/walkthrough-plan-drift-core.mjs";

export const PLAN_PATH = "docs/walkthroughs/TEST_PLAN.md";
const ENTRY_FILE = "server/src/app.ts";
const APP_DIR = "ui/src/app";

/** @param {string[]} argv @param {string} flag @returns {string | undefined} */
function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Every `page.*` under the app directory, relative to it, `/`-separated.
 *
 * @param {string} appDir
 * @returns {string[]}
 */
function listPages(appDir) {
  /** @type {string[]} */
  const pages = [];
  /** @param {string} dir @param {string} rel */
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else if (/^page\.(tsx|ts|jsx|js)$/.test(entry.name)) pages.push(childRel);
    }
  };
  walk(appDir, "");
  return pages;
}

function main() {
  const argv = process.argv.slice(2);
  const root =
    flagValue(argv, "--root") ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const planPath = path.resolve(root, flagValue(argv, "--plan") ?? PLAN_PATH);

  let plan;
  try {
    plan = fs.readFileSync(planPath, "utf8");
  } catch (error) {
    console.error(
      `Test plan drift check FAILED: cannot read ${planPath}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  const { routes, unresolved } = collectApiRoutes({
    entryFile: ENTRY_FILE,
    readSource: (file) => {
      try {
        return fs.readFileSync(path.join(root, ...file.split("/")), "utf8");
      } catch {
        return null;
      }
    },
  });

  let pageFiles;
  try {
    pageFiles = listPages(path.join(root, ...APP_DIR.split("/")));
  } catch (error) {
    console.error(
      `Test plan drift check FAILED: cannot list ${APP_DIR}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  // An empty route or page set means the walk found nothing, not that the
  // plan is clean: every reference would then fail, but a plan with no
  // checkable references would PASS against nothing. Refuse both.
  if (routes.length === 0 || pageFiles.length === 0) {
    console.error(
      `Test plan drift check FAILED: found ${routes.length} API route(s) from ${ENTRY_FILE} ` +
        `and ${pageFiles.length} page(s) under ${APP_DIR}. Both must be non-empty.`,
    );
    process.exit(1);
  }

  const refs = extractPlanReferences(plan);
  const problems = findPlanDrift({ refs, apiRoutes: routes, pageFiles });
  const rel = path.relative(root, planPath) || planPath;

  console.log(
    `Test plan drift: ${refs.length} reference(s) in ${rel} checked against ` +
      `${routes.length} API route(s) and ${pageFiles.length} page(s).`,
  );

  let failed = false;
  if (unresolved.length > 0) {
    failed = true;
    console.error("\nRouter mounts the walk could not follow (so their routes are unknown):");
    for (const u of unresolved) console.error(`  - ${u.file}: ${u.prefix} → ${u.target}`);
  }
  if (problems.length > 0) {
    failed = true;
    console.error(`\n${problems.length} reference(s) in ${rel} match nothing the tree serves:`);
    for (const p of problems) {
      console.error(`  - ${rel}:${p.line}  ${p.kind === "api" ? "API " : "page"} ${p.reference}`);
    }
    console.error(
      "\nUpdate the plan to the route or page that replaced it, or remove the step. A reference\n" +
        "that must stay dead on purpose goes on a line marked <!-- drift-check: skip -->.",
    );
  }
  if (failed) process.exit(1);
  console.log("Every API route and page the plan names exists.");
}

main();
