/**
 * On-disk store for record/replay LLM fixtures (#234).
 *
 * Each fixture is a single JSON file named `<key>.json` inside the fixture
 * directory, where `<key>` is the {@link fixtureKey} of the request. The file
 * holds the captured {@link ChatResponse} plus a small `request` echo (keyed
 * options + a human-readable prompt preview) so a developer browsing the
 * fixtures can tell what each one captures without decoding the hash.
 *
 * The store is intentionally filesystem-only and synchronous-free (async fs):
 * no database, no network. Replay reads are the hot path in CI and must never
 * touch a live LLM.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, ChatResponse } from "../types.js";
import { messageText } from "../types.js";
import { keyedOptions, type KeyedChatOptions } from "./fixture-key.js";

/** Default fixture directory, relative to the repo's `server/` cwd. */
export const DEFAULT_FIXTURE_DIR = "tests/fixtures/llm";

/** Persisted shape of a single fixture file. */
export interface FixtureRecord {
  /** Schema version — lets us migrate the on-disk format later. */
  version: 1;
  /** The deterministic key this fixture is stored under (echoed for clarity). */
  key: string;
  /** Echo of the request so humans can read the fixture. */
  request: {
    /** First ~200 chars of the last user message. */
    promptPreview: string;
    /** Number of messages in the request. */
    messageCount: number;
    /** The response-affecting option subset (see {@link keyedOptions}). */
    options: KeyedChatOptions;
  };
  /** The captured provider response replayed verbatim. */
  response: ChatResponse;
  /** ISO timestamp the fixture was (re)recorded — informational only. */
  recordedAt: string;
}

/**
 * Resolve the directory fixtures live in. Honours `AI_FIXTURE_DIR`; falls back
 * to {@link DEFAULT_FIXTURE_DIR}. Relative paths resolve against the supplied
 * `cwd` (defaults to `process.cwd()`), so both the server process and the e2e
 * harness can agree on the same absolute location.
 */
export function resolveFixtureDir(cwd: string = process.cwd()): string {
  const configured = process.env.AI_FIXTURE_DIR?.trim();
  const dir = configured && configured.length > 0 ? configured : DEFAULT_FIXTURE_DIR;
  return path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
}

/** Build a human-readable preview of the last user prompt. */
function promptPreview(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = messageText(lastUser ?? { content: "(no prompt)" });
  return text.slice(0, 200);
}

/**
 * File-backed fixture store. One instance per fixture directory; safe to
 * construct cheaply (no I/O until a read/write method is called).
 */
export class FixtureStore {
  constructor(private readonly dir: string) {}

  /** Absolute path to the fixture directory. */
  get directory(): string {
    return this.dir;
  }

  private fileFor(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  /**
   * Read a fixture by key. Returns `null` when the fixture is missing or the
   * file is unreadable/corrupt — callers decide whether a miss is fatal.
   */
  async read(key: string): Promise<FixtureRecord | null> {
    try {
      const raw = await fs.readFile(this.fileFor(key), "utf-8");
      const parsed = JSON.parse(raw) as FixtureRecord;
      if (parsed && parsed.version === 1 && parsed.response) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  /** True when a fixture exists for the key. */
  async has(key: string): Promise<boolean> {
    return (await this.read(key)) !== null;
  }

  /**
   * Persist a captured response under its key, creating the fixture directory
   * if needed. Overwrites an existing fixture (this is how `record` mode
   * refreshes a single entry).
   */
  async write(
    key: string,
    messages: ChatMessage[],
    opts: Parameters<typeof keyedOptions>[0],
    response: ChatResponse,
  ): Promise<FixtureRecord> {
    const record: FixtureRecord = {
      version: 1,
      key,
      request: {
        promptPreview: promptPreview(messages),
        messageCount: messages.length,
        options: keyedOptions(opts),
      },
      response,
      recordedAt: new Date().toISOString(),
    };
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.fileFor(key), `${JSON.stringify(record, null, 2)}\n`, "utf-8");
    return record;
  }

  /** List the keys of all fixtures currently on disk. */
  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.dir);
      return entries
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length));
    } catch {
      return [];
    }
  }
}
