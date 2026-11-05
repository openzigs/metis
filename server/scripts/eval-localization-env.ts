/**
 * #1755 — imported FIRST by `eval-localization.ts`: when `--arms` names an agent
 * arm, bind the database, clones and vectors to the materialized corpus before
 * any module that imports Prisma is evaluated (Prisma binds at import).
 */
import { agentArmsRequested, bindMaterializedEnv } from "../src/lib/eval/localization/agent-env.js";
import { materializeLayout } from "../src/lib/eval/localization/materialize.js";

if (agentArmsRequested(process.argv.slice(2))) {
  bindMaterializedEnv(process.env, materializeLayout());
}
