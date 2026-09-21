/**
 * METIS server entrypoint.
 *
 * Boots HTTP + Socket.IO and wires graceful shutdown:
 *   - On SIGINT/SIGTERM, stop accepting new HTTP connections, close
 *     Socket.IO, disconnect Prisma, and exit cleanly.
 *   - If shutdown takes longer than 10 s, force-exit with a non-zero code.
 *
 * The legacy scaffold constants (`SERVER_NAME`, `getServerBanner`) remain
 * exported so older smoke tests keep working.
 */
// Issue #109 — initialize OpenTelemetry BEFORE any other import so the
// HTTP / Express auto-instrumentation can patch their targets.
import "./lib/otel/init.js";
import { createServer } from "./server.js";
import { createChildLogger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { ensureSchemaUpToDate } from "./lib/db/migration-guard.js";
import { getAuthProvider } from "./lib/auth/providers.js";
import { assertJwtSecretConfigured } from "./lib/auth/jwt.js";
import { assertFinalAnswerMaxOutputTokensValid } from "./lib/analysis/agent-runner.js";
import { assertSynthesisMaxOutputTokensValid } from "./lib/analysis/synthesis.js";
import { getEmbedder } from "./lib/rag/embedder.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

export const SERVER_NAME = "metis-server";
export function getServerBanner(): string {
  return `${SERVER_NAME} (phase-2 server skeleton)`;
}

const log = createChildLogger("bootstrap");
const PORT = parseInt(process.env.PORT ?? "4000", 10);

/**
 * Issue #682 (follow-up) — eagerly resolve the auth provider AT BOOT.
 *
 * `getAuthProvider()` carries the production fail-fast guard (`providers.ts`)
 * that refuses to serve the insecure mock provider when
 * `NODE_ENV==='production'`. But it is otherwise called lazily — only on the
 * first login (`routes/auth.ts`) — so a misconfigured production process would
 * boot healthy and only surface the fault as a 500 on the first login attempt.
 *
 * Invoking it here, in the startup path before the server begins listening,
 * makes the guard fire AT BOOT: a prod deploy with `AUTH_MODE` unset, empty,
 * whitespace-only, a typo, or an explicit `mock` throws here and the process
 * exits non-zero (see the boot block below) instead of coming up insecure.
 * No-op in dev/test, where mock remains the intended default.
 */
export function assertStartupAuthConfig(): void {
  getAuthProvider();
}

/**
 * Issue #1057 (F8) — validate the JWT signing secret AT BOOT.
 *
 * `getSecret()` inside `jwt.ts` is lazy: without this call a deployment with a
 * missing or weak `JWT_SECRET` would boot healthy and only fail on the first
 * login. Calling it here means the process exits non-zero at startup instead,
 * and — in local development, where the publicly-known fallback key is still
 * allowed — the "insecure signing key" warning lands in the startup log where
 * an operator actually reads it.
 */
export function assertStartupSecretsConfig(): void {
  assertJwtSecretConfigured();
}

function isMainModule(): boolean {
  // Detect direct execution (`node dist/index.js`) vs test/library import.
  try {
    const url = new URL(import.meta.url);
    return url.pathname.endsWith("/index.js") || url.pathname.endsWith("/index.ts");
  } catch {
    return false;
  }
}

if (isMainModule() && process.env.METIS_NO_LISTEN !== "1") {
  // Issue #682 (follow-up) — fail fast on insecure auth config FIRST: a pure
  // env check that needs no DB, so a production process misconfigured to select
  // the mock provider exits here before doing any startup I/O.
  try {
    assertStartupAuthConfig();
  } catch (err) {
    log.error("Auth provider configuration invalid — refusing to start", {
      error: (err as Error).message,
    });
    process.exit(1);
  }
  // Issue #1057 — same idea for the token-signing secret: a pure env check, so
  // a deployment that would otherwise sign tokens with the published dev key
  // (or a weak staging secret) exits here rather than on the first login.
  try {
    assertStartupSecretsConfig();
  } catch (err) {
    log.error("JWT signing secret invalid — refusing to start", {
      error: (err as Error).message,
    });
    process.exit(1);
  }
  // Issue #1221 — reject a non-positive / non-numeric
  // ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS at config load. Left to call time
  // it surfaces as a provider rejection on the DEGRADED salvage pass, so the
  // operator sees a salvage failure rather than the config error it is. Same
  // shape as the two checks above: a pure config read, no I/O.
  try {
    assertFinalAnswerMaxOutputTokensValid();
  } catch (err) {
    log.error(
      "ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS is invalid — refusing to start. " +
        "It must be a positive integer; unset it to use the default.",
      {
        error: (err as Error).message,
        issues: (err as { issues?: unknown }).issues,
      },
    );
    process.exit(1);
  }
  // Issue #1257 — the same gate for the SYNTHESIS cap. #1221 added it for the
  // sibling knob only, and #1223 declined to reach into #1221's files to add the
  // second one mid-flight, so an invalid ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS
  // surfaced at the END of a multi-agent run — the most expensive moment in the
  // product to discover a typo.
  try {
    assertSynthesisMaxOutputTokensValid();
  } catch (err) {
    log.error(
      "ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS is invalid — refusing to start. " +
        "It must be a positive integer; unset it to use the default.",
      {
        error: (err as Error).message,
        issues: (err as { issues?: unknown }).issues,
      },
    );
    process.exit(1);
  }
  // Issues #379, #380 — apply pending Prisma migrations BEFORE accepting
  // traffic so we never serve requests against a drifted schema. Fails loud.
  try {
    await ensureSchemaUpToDate();
  } catch (err) {
    log.error("Schema migration guard failed — refusing to start", {
      error: (err as Error).message,
    });
    process.exit(1);
  }
  // Issue #783 — WARM THE EMBEDDER AT BOOT, and let it fail here.
  //
  // Deliberately NOT `process.exit(1)`: a dead process cannot tell anyone WHY. We
  // want the pod to come up, serve `/readyz` with `embeddings: error` (→ 503, so
  // the rollout stalls and traffic never arrives), and show the reason in Admin →
  // Embedding backends. `Embedder.warm()` memoises its rejection, so the failure
  // recorded here is exactly the one every later `embed()` call re-raises — the
  // one thing it will never do again is quietly substitute hash vectors.
  //
  // Awaited before `listen()` so the readiness answer is definite from the first
  // probe rather than racing it. A warm hits a cache in a baked image and costs
  // one HTTP round-trip on the sidecar path.
  try {
    await getEmbedder().warm();
    const state = getEmbedder().snapshot();
    log.info("Embeddings backend ready", {
      backend: state.backend,
      model: state.model,
      dimension: state.dimension,
      fellBack: state.fellBack,
    });
  } catch (err) {
    log.error(
      "Embeddings backend FAILED to load — the server will start but /readyz will report " +
        "embeddings=error (503) and every embed call will fail. It will NOT silently write " +
        "hash vectors. Fix the backend, or set EMBED_ALLOW_HASH_FALLBACK=1 to accept " +
        "non-semantic vectors deliberately.",
      { error: (err as Error).message },
    );
  }

  const { http: httpServer, io, acp, prReviewWorker } = createServer();
  httpServer.listen(PORT, () => {
    log.info("METIS server listening", { port: PORT, env: process.env.NODE_ENV });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Shutdown signal received", { signal });

    const force = setTimeout(() => {
      log.error("Forced exit after 10s shutdown timeout");
      process.exit(1);
    }, 10_000);
    force.unref?.();

    httpServer.close(async (err) => {
      if (err) log.error("HTTP close error", { error: err.message });
      try {
        // Epic #394 P2 review F4 — drain the PR-reviewer queue + cancel
        // the dedup-purge interval before tearing down dependencies the
        // processor uses (Prisma, Socket.IO).
        await prReviewWorker.shutdown();
      } catch (e) {
        log.error("PR-review worker close error", { error: (e as Error).message });
      }
      try {
        await acp.shutdown();
      } catch (e) {
        log.error("ACP close error", { error: (e as Error).message });
      }
      try {
        await io.close();
      } catch (e) {
        log.error("Socket.IO close error", { error: (e as Error).message });
      }
      // M3 — sweep per-session COPILOT_HOME dirs for any session still
      // marked active. Best-effort: a failed cleanup must not block exit.
      try {
        const active = await prisma.aISession.findMany({
          where: { status: "active", deletedAt: null },
          select: { id: true },
        });
        const root = process.env.METIS_SESSIONS_HOME ?? path.join(os.homedir(), ".metis-sessions");
        await Promise.all(
          active.map((s) =>
            fs.rm(path.join(root, s.id), { recursive: true, force: true }).catch(() => undefined),
          ),
        );
        if (active.length > 0) {
          log.info("Cleaned per-session AI homes", { count: active.length });
        }
      } catch (e) {
        log.error("AI session cleanup error", { error: (e as Error).message });
      }
      try {
        await prisma.$disconnect();
      } catch (e) {
        log.error("Prisma disconnect error", { error: (e as Error).message });
      }
      log.info("Shutdown complete");
      clearTimeout(force);
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
