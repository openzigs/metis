/**
 * CopilotWrapper — METIS adaptation of `talos/src/copilot/copilot-wrapper.ts`.
 *
 * Lifts the device-auth + session/streaming pattern but:
 *   • repoints the cached auth state to `~/.metis/auth.json`
 *   • drops the talos tool plumbing (METIS uses its own ToolRegistry)
 *   • exposes a strict {@link CopilotClientLike} seam so tests can run
 *     without the actual `@github/copilot-sdk` dependency
 *   • adds R-SDK-9 per-session COPILOT_HOME isolation
 *
 * The wrapper is provider-agnostic: the same class drives both the native
 * Copilot route (default device-auth → GitHub-hosted models) and the
 * Bedrock-gateway route (BYOK via `provider` config).
 */
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createChildLogger } from "../logger.js";
import type { BYOKProviderConfig } from "./config.js";

const log = createChildLogger("ai-copilot-wrapper");

interface AuthState {
  token: string;
  refreshToken?: string;
  expiresAt?: number;
  obtainedAt: number;
}

export interface CopilotSessionLike {
  readonly sessionId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (event: string, handler: (event: any) => void) => () => void;
  send: (input: { prompt: string }) => Promise<unknown>;
  sendAndWait?: (input: { prompt: string }, timeoutMs?: number) => Promise<unknown>;
  destroy?: () => Promise<void>;
  disconnect?: () => Promise<void>;
}

export interface CopilotClientLike {
  start?: () => Promise<void>;
  stop?: () => Promise<unknown>;
  getAuthStatus?: () => Promise<{ isAuthenticated: boolean; authType?: string }>;
  listModels?: () => Promise<Array<{ id: string }>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createSession: (config: any) => Promise<CopilotSessionLike>;
}

export interface CopilotWrapperOptions {
  /** Inject a stub client in tests. When omitted, the real SDK is loaded lazily. */
  client?: CopilotClientLike;
  /** Override the cached-auth file path (defaults to `~/.metis/auth.json`). */
  authPath?: string;
  /** Default model when callers don't provide one. */
  model?: string;
  /** Long-running auth wait timeout. */
  /** BYOK provider override (Bedrock gateway, Azure, etc.). */
  provider?: BYOKProviderConfig;
  /** Optional pre-resolved GitHub PAT — bypasses device flow. */
  githubToken?: string;
  /** Per-session COPILOT_HOME root (R-SDK-9). Defaults to `~/.metis-sessions`. */
  sessionHomeRoot?: string;
}

const defaultAuthPath = (): string => path.join(os.homedir(), ".metis", "auth.json");
const defaultSessionHomeRoot = (): string =>
  process.env.METIS_SESSION_HOME_ROOT?.trim() || path.join(os.homedir(), ".metis-sessions");

/**
 * Resolve the COPILOT_HOME directory for a given session id without needing
 * a live {@link CopilotWrapper}. Uses the same `~/.metis-sessions/<id>`
 * convention so callers (e.g. Phase 10 skill materialisation in the AI
 * route) write into the directory the wrapper will later hand to the SDK.
 *
 * Honours the `METIS_SESSION_HOME_ROOT` env var so tests + container
 * deployments can redirect the per-session tree.
 */
export function resolveCopilotHomeForSession(sessionId: string): string {
  const root = process.env.METIS_SESSION_HOME_ROOT?.trim() || defaultSessionHomeRoot();
  return path.join(root, sessionId);
}

/**
 * Read the GitHub Copilot extension's stashed OAuth token. EMU accounts that
 * cannot complete device flow can still hit the SDK by reusing the editor
 * extension's credentials.
 */
async function readCopilotSdkToken(): Promise<string | null> {
  try {
    const appsPath = path.join(os.homedir(), ".config", "github-copilot", "apps.json");
    const raw = await fs.readFile(appsPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, { oauth_token?: string }>;
    for (const entry of Object.values(parsed)) {
      if (entry.oauth_token) return entry.oauth_token;
    }
    return null;
  } catch {
    return null;
  }
}

export async function readAuthState(authPath: string): Promise<AuthState | null> {
  try {
    const raw = await fs.readFile(authPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AuthState>;
    if (!parsed.token) return null;
    return {
      token: parsed.token,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      obtainedAt: parsed.obtainedAt ?? Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Write the cached auth file.
 *
 * **Nothing in METIS calls this in production any more.** Its only caller was
 * `waitForAuth`, removed in #1348 because the SDK has never shipped the device-auth
 * members it depended on. The function is kept because it is the writer half of a pair
 * whose reader ({@link readAuthState}) is still live: `~/.metis/auth.json` is now an
 * OPERATOR-SUPPLIED file, and this is what defines the shape one must have. Tests use it
 * to build valid fixtures rather than hand-rolling JSON that could drift from the schema.
 */
export async function writeAuthState(authPath: string, state: AuthState): Promise<void> {
  await fs.mkdir(path.dirname(authPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(authPath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * Lazily import `@github/copilot-sdk`. Wrapped so unit tests never trip the
 * import (we always inject a `CopilotClientLike` in tests).
 */
export async function loadCopilotClientCtor(): Promise<{
  CopilotClient: new (opts?: {
    githubToken?: string;
    useLoggedInUser?: boolean;
  }) => CopilotClientLike;
}> {
  const mod = (await import("@github/copilot-sdk")) as unknown as {
    CopilotClient: new (opts?: {
      githubToken?: string;
      useLoggedInUser?: boolean;
    }) => CopilotClientLike;
  };
  return { CopilotClient: mod.CopilotClient };
}

export class CopilotWrapper extends EventEmitter {
  private client?: CopilotClientLike;
  private readonly clientFactory: () => Promise<CopilotClientLike>;
  private readonly authPath: string;
  private readonly providerConfig?: BYOKProviderConfig;
  private readonly sessionHomeRoot: string;
  private model: string;
  private githubToken?: string;
  private started = false;
  private startPromise?: Promise<void>;

  constructor(opts: CopilotWrapperOptions = {}) {
    super();
    this.authPath = opts.authPath ?? defaultAuthPath();
    this.model = opts.model ?? "gpt-4.1";
    this.providerConfig = opts.provider;
    this.sessionHomeRoot = opts.sessionHomeRoot ?? defaultSessionHomeRoot();
    this.githubToken =
      opts.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.COPILOT_GITHUB_TOKEN;

    if (opts.client) {
      this.client = opts.client;
      this.clientFactory = async () => opts.client!;
    } else {
      const token = this.githubToken;
      this.clientFactory = async () => {
        const { CopilotClient } = await loadCopilotClientCtor();
        return token
          ? new CopilotClient({ githubToken: token, useLoggedInUser: false })
          : new CopilotClient();
      };
    }
  }

  /** Resolves to the active SDK client, lazily constructing it if needed. */
  async getClient(): Promise<CopilotClientLike> {
    if (!this.client) this.client = await this.clientFactory();
    return this.client;
  }

  /**
   * Start the SDK once. Subsequent calls reuse the same in-flight promise so
   * concurrent callers don't double-start the client.
   */
  async ensureStarted(): Promise<void> {
    if (this.started) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    this.startPromise = (async () => {
      const client = await this.getClient();
      if (client.start) await client.start();
      this.started = true;
    })();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    if (!this.client?.stop) return;
    try {
      await this.client.stop();
    } catch (err) {
      log.warn("Copilot client stop failed", { error: (err as Error).message });
    }
    this.started = false;
  }

  /** Resolve a token via env → cached auth file → editor extension. */
  async resolveToken(): Promise<string | null> {
    if (this.githubToken) return this.githubToken;
    const state = await readAuthState(this.authPath);
    if (state?.token) return state.token;
    return readCopilotSdkToken();
  }

  /**
   * Returns `true` when:
   *   • a process-level token is available, OR
   *   • a non-expired cached auth file exists, OR
   *   • the SDK reports `isAuthenticated`.
   */
  async isAuthenticated(): Promise<boolean> {
    if (this.githubToken) return true;
    const cached = await readAuthState(this.authPath);
    if (cached && (!cached.expiresAt || Date.now() < cached.expiresAt)) return true;
    try {
      const client = await this.getClient();
      const status = await client.getAuthStatus?.();
      return Boolean(status?.isAuthenticated);
    } catch {
      return false;
    }
  }

  /** Compute the per-session COPILOT_HOME directory (R-SDK-9). */
  sessionHomeFor(sessionId: string): string {
    return path.join(this.sessionHomeRoot, sessionId);
  }

  /** Create or recycle a session for the given conversation id. */
  async createSession(input: {
    sessionId: string;
    model?: string;
    streaming?: boolean;
    systemMessage?: { mode: "append" | "replace"; content: string };
    onPermissionRequest?: unknown;
    /**
     * Issue #113 — extra directories the SDK should scan for `SKILL.md`
     * files. Phase 10 materializes loaded library skills into
     * `<copilotHome>/skills/` and forwards that path here so the SDK loads
     * them natively. Pass additional read-only directories (e.g.
     * `.github/skills` from the project) to layer them on top.
     */
    skillDirectories?: string[];
    /**
     * Issue #113 — skill keys the SDK should NOT load even if they are
     * present on disk. Mirrors the per-project allow-list disabled rows.
     */
    disabledSkills?: string[];
    /**
     * Restrict the tools exposed to the model for this session. Pass an
     * empty array (`[]`) to disable all tools — useful for pure
     * text-synthesis sessions (doc generation) where the model should
     * only produce prose from the supplied context.
     */
    availableTools?: string[];
  }): Promise<CopilotSessionLike> {
    await this.ensureStarted();
    const client = await this.getClient();
    const cfg: Record<string, unknown> = {
      model: input.model ?? this.model,
      streaming: input.streaming ?? true,
      ...(input.systemMessage ? { systemMessage: input.systemMessage } : {}),
      ...(this.providerConfig ? { provider: this.providerConfig } : {}),
      ...(input.onPermissionRequest ? { onPermissionRequest: input.onPermissionRequest } : {}),
      sessionId: input.sessionId,
      copilotHome: this.sessionHomeFor(input.sessionId),
      ...(input.skillDirectories && input.skillDirectories.length > 0
        ? { skillDirectories: input.skillDirectories }
        : {}),
      ...(input.disabledSkills && input.disabledSkills.length > 0
        ? { disabledSkills: input.disabledSkills }
        : {}),
      ...(input.availableTools !== undefined ? { availableTools: input.availableTools } : {}),
    };
    return client.createSession(cfg);
  }

  /** Tear down a per-session COPILOT_HOME directory (R-SDK-9 cleanup). */
  async cleanupSessionHome(sessionId: string): Promise<void> {
    const dir = this.sessionHomeFor(sessionId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      log.warn("Session home cleanup failed", { sessionId, error: (err as Error).message });
    }
  }

  async listModels(): Promise<string[]> {
    await this.ensureStarted();
    const client = await this.getClient();
    if (!client.listModels) return [this.model];
    try {
      const models = await client.listModels();
      return models.map((m) => m.id);
    } catch (err) {
      log.warn("listModels failed; falling back to default", { error: (err as Error).message });
      return [this.model];
    }
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  hasGithubToken(): boolean {
    return Boolean(this.githubToken);
  }
}
