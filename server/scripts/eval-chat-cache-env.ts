/**
 * #1845 — imported FIRST by `eval-chat-cache.ts`: bind the database, clones and
 * vectors to the materialized corpus before any module that imports Prisma is
 * evaluated (Prisma binds at import, and the chat-cache modules reach it
 * through the content version).
 */
import { bindMaterializedEnv } from "../src/lib/eval/localization/agent-env.js";
import { materializeLayout } from "../src/lib/eval/localization/materialize.js";

bindMaterializedEnv(process.env, materializeLayout());
