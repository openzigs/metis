import type { PermissionKey, RoleKey } from "@metis/shared";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: RoleKey;
  permissions: readonly PermissionKey[];
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface LoginResponse {
  user: AuthUser;
}
