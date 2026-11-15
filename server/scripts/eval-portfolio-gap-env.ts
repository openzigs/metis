/**
 * #1766 — imported FIRST by `eval-portfolio-gap.ts`: bind the database, clones,
 * vectors and stored documents to the materialized eval layout before any module
 * that reads them is evaluated (Prisma binds at import), whatever a loaded `.env`
 * said. The embedder is the local one the materialization used.
 */
import path from "node:path";
import { bindMaterializedEnv } from "../src/lib/eval/localization/agent-env.js";
import { materializeLayout } from "../src/lib/eval/localization/materialize.js";

const layout = materializeLayout();
bindMaterializedEnv(process.env, layout);
process.env.UPLOAD_STORAGE_BACKEND = "local";
process.env.UPLOAD_DIR = path.join(layout.root, "uploads");
process.env.VECTOR_STORE = "lancedb";
process.env.EMBED_BACKEND = "xenova";
process.env.EMBEDDINGS_MODE = "in-process";
process.env.EMBED_INPROCESS_RUNTIME = "worker";
process.env.EMBED_MODEL = "Alibaba-NLP/gte-modernbert-base";
