/**
 * Re-exports for the shared RBAC registry — keeps server code importing from
 * one local barrel instead of reaching into `@metis/shared` for both
 * permissions and role helpers.
 */
export {
  PERMISSION_KEYS,
  ROLE_KEYS,
  ROLE_HIERARCHY,
  ROLE_PERMISSIONS,
  hasPermission,
  hasMinRole,
  getPermissionsForRole,
  type PermissionKey,
  type RoleKey,
} from "@metis/shared";
