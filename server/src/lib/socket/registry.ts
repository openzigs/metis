/**
 * Epic #728 — Lightweight module-level Socket.IO server registry.
 *
 * Allows lib code (e.g. the @mention fan-out service) to obtain the live IO
 * instance without circular imports or dependency injection threading.
 * Registered once at server bootstrap by `server.ts`.
 */
import type { MetisIOServer } from "./server.js";

let _io: MetisIOServer | null = null;

/** Register the IO server at bootstrap. */
export function registerSocketServer(io: MetisIOServer): void {
  _io = io;
}

/** Get the registered IO server, or null if not yet registered (tests). */
export function getSocketServer(): MetisIOServer | null {
  return _io;
}
