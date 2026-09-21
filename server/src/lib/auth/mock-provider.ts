/**
 * Mock auth provider for local development and tests.
 *
 * Backs the four roles defined in the seed: admin / coordinator / developer /
 * reader. Password is always `password`. Never enable in production — the
 * provider factory (`providers.ts`) fails fast at startup when
 * `NODE_ENV==='production'` and the resolved provider is mock (explicit
 * `AUTH_MODE=mock`, or an unset/empty/unrecognized value that would fall back
 * to mock), so it cannot be activated in production.
 */
import type { RoleKey } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import type { AuthProvider, AuthResult, AuthenticatedUser } from "./types.js";

const log = createChildLogger("mock-auth");

interface MockUser extends AuthenticatedUser {
  password: string;
}

export const MOCK_USERS: readonly MockUser[] = [
  {
    username: "admin",
    password: "password",
    displayName: "System Admin",
    email: "admin@metis.local",
    role: "admin" as RoleKey,
  },
  {
    username: "coordinator",
    password: "password",
    displayName: "Test Coordinator",
    email: "coordinator@metis.local",
    role: "coordinator" as RoleKey,
  },
  {
    username: "developer",
    password: "password",
    displayName: "Test Developer",
    email: "developer@metis.local",
    role: "developer" as RoleKey,
  },
  {
    username: "reader",
    password: "password",
    displayName: "Read Only User",
    email: "reader@metis.local",
    role: "reader" as RoleKey,
  },
];

export class MockAuthProvider implements AuthProvider {
  readonly name = "mock";

  async authenticate(username: string, password: string): Promise<AuthResult> {
    const user = MOCK_USERS.find((u) => u.username === username && u.password === password);
    if (!user) {
      log.warn("Mock auth failed", { username });
      return { success: false, error: "Invalid username or password" };
    }
    log.info("Mock auth succeeded", { username, role: user.role });
    const { password: _password, ...safe } = user;
    return { success: true, user: safe };
  }
}
