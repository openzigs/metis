/**
 * #2237 — imported FIRST by `eval-ba-qa.ts`: bind the database, clones, vectors
 * and uploads to the materialized eval layout before any module that reads them
 * is evaluated, whatever a loaded `.env` said. The embedder is the local one the
 * materialization embedded the symbols with; the `on` arm runs it inline so its
 * cross-encoder reranker can share the main thread (#222).
 */
import path from "node:path";
import { bindMaterializedEnv } from "../src/lib/eval/localization/agent-env.js";
import { materializeLayout } from "../src/lib/eval/localization/materialize.js";
import { armArgument, embedRuntimeFor } from "../src/lib/eval/ba-qa/run.js";

const layout = materializeLayout();
bindMaterializedEnv(process.env, layout);
process.env.UPLOAD_STORAGE_BACKEND = "local";
process.env.UPLOAD_DIR = path.join(layout.root, "uploads");
process.env.VECTOR_STORE = "lancedb";
process.env.EMBED_BACKEND = "xenova";
process.env.EMBEDDINGS_MODE = "in-process";
process.env.EMBED_INPROCESS_RUNTIME = embedRuntimeFor(armArgument(process.argv.slice(2)));
process.env.EMBED_MODEL = process.env.BAQA_EMBED_MODEL ?? "Alibaba-NLP/gte-modernbert-base";
