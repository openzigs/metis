/**
 * `metis-copilot-svc` — boot script.
 *
 * Mirrors `embeddings-svc/src/index.ts` so ops commands stay symmetrical:
 * graceful SIGTERM/SIGINT shutdown, single port + host env binding, no
 * surprise side effects beyond `createApp()`.
 */
import { createServer } from "node:http";
import { createApp } from "./app.js";

const PORT = Number(process.env.COPILOT_NATIVE_PORT ?? 5060);
const HOST = process.env.COPILOT_NATIVE_HOST ?? "0.0.0.0";

const app = createApp();
const server = createServer(app);

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[copilot-svc] listening on http://${HOST}:${PORT}`);
});

const shutdown = (signal: string): void => {
  // eslint-disable-next-line no-console
  console.log(`[copilot-svc] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
