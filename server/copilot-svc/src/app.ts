/**
 * `metis-copilot-svc` HTTP surface.
 *
 * Exposes the `@github/copilot-sdk` shape over Bearer-authenticated HTTP so
 * the main `metis-server` image can stay slim (the SDK + its native deps
 * live here exclusively).
 *
 * Endpoints (Issue #180, Topic 1 of the research summary):
 *   GET    /healthz                              — liveness, no auth
 *   GET    /auth/status                          — getAuthStatus
 *   GET    /models                               — listModels
 *   POST   /sessions                             — createSession
 *   POST   /sessions/:id/send                    — SSE stream of events
 *   POST   /sessions/:id/send-and-wait           — sendAndWait, single response
 *   DELETE /sessions/:id                         — destroy / disconnect
 *
 * Auth: Bearer `COPILOT_NATIVE_TOKEN` with `timingSafeEqual`. Service
 * fail-closes (503) when the token is unset — refusing to serve anything
 * authenticated rather than allowing unauthenticated traffic. `/healthz`
 * is the only unauthenticated route.
 *
 * v1 limitation: `onPermissionRequest` is NOT proxied over HTTP. Sessions
 * accept a `permissionMode` of `"auto-approve" | "deny"`; `"interactive"`
 * is rejected with HTTP 400.
 */
import { timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { SessionRegistry, type CopilotSession } from "./sessions.js";
import {
  execInSandbox,
  isSandboxConfigured,
  SandboxConfigError,
  SandboxTimeoutError,
  SandboxUnavailableError,
} from "./sandbox.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

/** Subset of the SDK client surface the sidecar depends on. */
export interface CopilotClientLike {
  start?: () => Promise<void>;
  stop?: () => Promise<unknown>;
  getAuthStatus?: () => Promise<{ isAuthenticated: boolean; authType?: string }>;
  listModels?: () => Promise<Array<{ id: string }>>;
  createSession: (config: AnyRecord) => Promise<CopilotSession>;
}

export interface AppDeps {
  /** Inject a stub client in tests. When omitted, the real SDK is loaded lazily. */
  loadClient?: () => Promise<CopilotClientLike>;
  /** Override the in-memory session registry (tests). */
  registry?: SessionRegistry;
  /** Inject a Morph apply client (tests). When omitted, the real Morph API is called. */
  morphApply?: MorphApplyClientLike["apply"];
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

function readToken(): string | null {
  const raw = process.env.COPILOT_NATIVE_TOKEN;
  if (!raw || raw.trim().length === 0) return null;
  return raw.trim();
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expected = readToken();
  if (!expected) {
    res.status(503).json({
      error: "service_unavailable",
      message:
        "COPILOT_NATIVE_TOKEN is not configured — the sidecar refuses requests until a shared secret is set.",
    });
    return;
  }
  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const presented = match?.[1]?.trim() ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  let ok = a.length === b.length;
  if (ok) {
    try {
      ok = timingSafeEqual(a, b);
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

/* -------------------------------------------------------------------------- */
/* Lazy SDK loader                                                            */
/* -------------------------------------------------------------------------- */

let cachedClient: CopilotClientLike | null = null;
let cachedLoader: (() => Promise<CopilotClientLike>) | null = null;

async function defaultLoadClient(): Promise<CopilotClientLike> {
  // Ditto the wrapper: dynamic import keeps unit tests free of the SDK dep.
  const mod = (await import("@github/copilot-sdk")) as unknown as {
    CopilotClient: new (opts?: {
      githubToken?: string;
      useLoggedInUser?: boolean;
    }) => CopilotClientLike;
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.COPILOT_GITHUB_TOKEN;
  return token
    ? new mod.CopilotClient({ githubToken: token, useLoggedInUser: false })
    : new mod.CopilotClient();
}

async function getClient(loader: () => Promise<CopilotClientLike>): Promise<CopilotClientLike> {
  if (cachedClient) return cachedClient;
  cachedClient = await loader();
  if (cachedClient.start) {
    try {
      await cachedClient.start();
    } catch {
      /* start failures surface on first real call */
    }
  }
  return cachedClient;
}

/** Test hook — drop the cached client + loader. */
export function __resetClientCache(): void {
  cachedClient = null;
  cachedLoader = null;
}

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

const createSessionSchema = z
  .object({
    sessionId: z.string().min(1),
    model: z.string().min(1).optional(),
    streaming: z.boolean().optional(),
    systemMessage: z
      .object({
        mode: z.enum(["append", "replace"]),
        content: z.string(),
      })
      .optional(),
    /**
     * v1 limitation: `interactive` is rejected — `onPermissionRequest` is
     * NOT proxied over HTTP. Either auto-approve every tool call or deny
     * everything.
     */
    permissionMode: z.enum(["auto-approve", "deny", "interactive"]).optional(),
    copilotHome: z.string().min(1).optional(),
    skillDirectories: z.array(z.string().min(1)).optional(),
    disabledSkills: z.array(z.string().min(1)).optional(),
    // BYOK pass-through; shape is provider-specific so we keep it loose.
    provider: z.unknown().optional(),
  })
  .strict();

const sendSchema = z.object({
  prompt: z.string().min(1),
});

const sendAndWaitSchema = sendSchema.extend({
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(30 * 60 * 1000)
    .optional(),
});

/* -------------------------------------------------------------------------- */
/* Morph apply (Epic #195 / Issue #218)                                       */
/* -------------------------------------------------------------------------- */

const applyDiffSchema = z.object({
  original: z.string(),
  patch: z.string().min(1),
  path: z.string().optional(),
  model: z.string().optional(),
});

export interface MorphApplyResult {
  content: string;
  provider: "morph";
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  durationMs: number;
}

export interface MorphApplyClientLike {
  apply(input: {
    original: string;
    patch: string;
    path?: string;
    model?: string;
  }): Promise<MorphApplyResult>;
}

const MORPH_API_URL = process.env.MORPH_API_URL ?? "https://api.morphllm.com/v1/apply";
const MORPH_DEFAULT_MODEL = process.env.MORPH_MODEL ?? "morph-v3";
const MORPH_TIMEOUT_MS = Math.max(
  1_000,
  Number.parseInt(process.env.MORPH_API_TIMEOUT_MS ?? "30000", 10) || 30_000,
);

/**
 * Default Morph API client. Refuses to start without `MORPH_API_KEY` (the
 * key is vault-injected at sidecar boot time).
 */
async function defaultMorphApply(input: {
  original: string;
  patch: string;
  path?: string;
  model?: string;
}): Promise<MorphApplyResult> {
  const key = process.env.MORPH_API_KEY?.trim();
  if (!key) {
    throw new Error("MORPH_API_KEY is not configured");
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MORPH_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await globalThis.fetch(MORPH_API_URL, {
      method: "POST",
      signal: ac.signal,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: input.model ?? MORPH_DEFAULT_MODEL,
        original: input.original,
        patch: input.patch,
        path: input.path,
      }),
    });
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text();
      throw new Error(`morph upstream HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      content?: string;
      result?: string;
      model?: string;
      usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
    };
    const content = body.content ?? body.result ?? "";
    const usage = body.usage ?? {};
    return {
      content,
      provider: "morph",
      model: body.model ?? input.model ?? MORPH_DEFAULT_MODEL,
      usage: {
        promptTokens: usage.promptTokens ?? 0,
        completionTokens: usage.completionTokens ?? 0,
        totalTokens: usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
      },
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* App factory                                                                */
/* -------------------------------------------------------------------------- */

export function createApp(deps: AppDeps = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8mb" }));

  const registry = deps.registry ?? new SessionRegistry();
  // Reuse the same loader across requests so we cache the SDK client.
  const loader = deps.loadClient ?? defaultLoadClient;
  if (cachedLoader !== loader) {
    // New loader injected (typically from a test) — invalidate any cached client.
    cachedClient = null;
    cachedLoader = loader;
  }

  /* ------------------------------- /healthz ------------------------------- */

  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      service: "metis-copilot",
      tokenConfigured: readToken() !== null,
      activeSessions: registry.size(),
    });
  });

  /* ------------------------------ /auth/status ---------------------------- */

  app.get("/auth/status", authMiddleware, async (_req, res) => {
    try {
      const client = await getClient(loader);
      if (!client.getAuthStatus) {
        res.status(501).json({ error: "not_supported", method: "getAuthStatus" });
        return;
      }
      const status = await client.getAuthStatus();
      res.json(status);
    } catch (err) {
      res
        .status(500)
        .json({ error: "auth_status_failed", message: (err as Error).message ?? "unknown" });
    }
  });

  /* -------------------------------- /models ------------------------------- */

  app.get("/models", authMiddleware, async (_req, res) => {
    try {
      const client = await getClient(loader);
      if (!client.listModels) {
        res.status(501).json({ error: "not_supported", method: "listModels" });
        return;
      }
      const models = await client.listModels();
      res.json({ models });
    } catch (err) {
      res
        .status(500)
        .json({ error: "list_models_failed", message: (err as Error).message ?? "unknown" });
    }
  });

  /* ------------------------------ /sessions ------------------------------- */

  app.post("/sessions", authMiddleware, async (req, res) => {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "bad_request", details: parsed.error.flatten() });
      return;
    }
    if (parsed.data.permissionMode === "interactive") {
      res.status(400).json({
        error: "interactive_permission_not_supported",
        message:
          'permissionMode="interactive" requires onPermissionRequest round-trips which are not proxied over HTTP in v1. Use "auto-approve" or "deny".',
      });
      return;
    }

    const { permissionMode, ...rest } = parsed.data;
    const cfg: AnyRecord = { ...rest };

    if (permissionMode === "auto-approve") {
      cfg.onPermissionRequest = async () => ({ approved: true });
    } else if (permissionMode === "deny") {
      cfg.onPermissionRequest = async () => ({ approved: false });
    }

    try {
      const client = await getClient(loader);
      const session = await client.createSession(cfg);
      registry.set(session, parsed.data.copilotHome);
      res.json({ sessionId: session.sessionId });
    } catch (err) {
      res
        .status(500)
        .json({ error: "create_session_failed", message: (err as Error).message ?? "unknown" });
    }
  });

  /* ---------------------------- /sessions/:id/send ------------------------ */

  app.post("/sessions/:id/send", authMiddleware, async (req, res) => {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "bad_request", details: parsed.error.flatten() });
      return;
    }
    const sessionId = String(req.params.id ?? "");
    const session = registry.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "session_not_found", sessionId });
      return;
    }
    if (!session.send || !session.on) {
      res.status(501).json({ error: "send_not_supported" });
      return;
    }

    // Server-Sent Events. Each event we forward from the SDK becomes one
    // `event:`/`data:` frame. The client subscribes via undici and re-emits
    // them on a `CopilotSession`-shaped object.
    res.status(200);
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    const FORWARDED_EVENTS = [
      "assistant.message",
      "assistant.message_delta",
      "session.idle",
      "usage",
    ];
    const offFns: Array<() => void> = [];

    const writeEvent = (event: string, data: unknown): void => {
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* socket closed */
      }
    };

    let idleEmitted = false;
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      for (const off of offFns) {
        try {
          off();
        } catch {
          /* swallow */
        }
      }
    };

    res.on("close", cleanup);

    for (const ev of FORWARDED_EVENTS) {
      const off = session.on(ev, (payload) => {
        if (closed) return;
        writeEvent(ev, payload);
        if (ev === "session.idle") {
          idleEmitted = true;
          // End the response gracefully — the wrapper treats `session.idle`
          // as the terminating event for a single send.
          try {
            res.end();
          } catch {
            /* ignore */
          }
          cleanup();
        }
      });
      // The SDK returns an unsubscribe fn from `on`. Tolerate both
      // shapes: void return = the session lifecycle owns the listener.
      if (typeof off === "function") offFns.push(off);
    }

    registry.touch(sessionId);

    try {
      await session.send(parsed.data);
      // Some SDK paths complete `send` without emitting `session.idle` —
      // in that case the response stays open until the client tears it
      // down or the TTL fires. Document the fallback by writing a final
      // "session.complete" comment so curl/SSE clients see something.
      if (!idleEmitted) {
        writeEvent("session.complete", { source: "send_resolved" });
        res.end();
        cleanup();
      }
    } catch (err) {
      if (!closed) {
        writeEvent("error", {
          message: (err as Error).message ?? "send_failed",
        });
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      cleanup();
    }
  });

  /* ---------------------- /sessions/:id/send-and-wait --------------------- */

  app.post("/sessions/:id/send-and-wait", authMiddleware, async (req, res) => {
    const parsed = sendAndWaitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "bad_request", details: parsed.error.flatten() });
      return;
    }
    const sessionId = String(req.params.id ?? "");
    const session = registry.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "session_not_found", sessionId });
      return;
    }
    if (!session.sendAndWait) {
      res.status(501).json({ error: "send_and_wait_not_supported" });
      return;
    }
    registry.touch(sessionId);
    try {
      const out = await session.sendAndWait({ prompt: parsed.data.prompt }, parsed.data.timeoutMs);
      res.json({ result: out ?? null });
    } catch (err) {
      res
        .status(500)
        .json({ error: "send_and_wait_failed", message: (err as Error).message ?? "unknown" });
    }
  });

  /* --------------------------- DELETE /sessions/:id ----------------------- */

  app.delete("/sessions/:id", authMiddleware, async (req, res) => {
    const sessionId = String(req.params.id ?? "");
    const ok = await registry.destroy(sessionId);
    res.status(ok ? 204 : 404).end();
  });

  /* ------------------------------- /apply --------------------------------- */
  // Epic #195 — morph_apply provider. Wraps the upstream Morph API behind the
  // sidecar's bearer auth so the main METIS image never sees MORPH_API_KEY.

  const morphApply = deps.morphApply ?? defaultMorphApply;
  app.post("/apply", authMiddleware, async (req, res) => {
    const parsed = applyDiffSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "bad_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const out = await morphApply(parsed.data);
      res.json(out);
    } catch (err) {
      const message = (err as Error).message ?? "unknown";
      const status = /MORPH_API_KEY/.test(message) ? 503 : 502;
      res.status(status).json({ error: "morph_apply_failed", message });
    }
  });

  /* ---------------------------- /sandbox/exec ----------------------------- */
  // Epic #192 (A.1) — E2B Firecracker microVM exec. Bearer-auth, fail-closed
  // when E2B_API_KEY is missing, hard-capped at 120s. The SDK is only loaded
  // when a real exec is attempted so the slim image stays under 350 MB.

  const sandboxExecSchema = z.object({
    language: z.enum(["python", "node", "bash"]),
    code: z
      .string()
      .min(1)
      .max(64 * 1024),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  });

  app.post("/sandbox/exec", authMiddleware, async (req, res) => {
    if (!isSandboxConfigured()) {
      res.status(503).json({
        error: "sandbox_unavailable",
        message: "E2B_API_KEY is not configured — sandbox exec refused.",
      });
      return;
    }
    const parsed = sandboxExecSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "bad_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const out = await execInSandbox(parsed.data);
      res.json(out);
    } catch (err) {
      if (err instanceof SandboxTimeoutError) {
        res.status(504).json({ error: "sandbox_timeout", message: err.message });
        return;
      }
      if (err instanceof SandboxConfigError) {
        res.status(503).json({ error: "sandbox_unavailable", message: err.message });
        return;
      }
      if (err instanceof SandboxUnavailableError) {
        res.status(503).json({ error: "sandbox_unavailable", message: err.message });
        return;
      }
      res
        .status(502)
        .json({ error: "sandbox_failed", message: (err as Error).message ?? "unknown" });
    }
  });

  // Catch-all 404.
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return app;
}
