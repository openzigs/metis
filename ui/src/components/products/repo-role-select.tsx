/**
 * #2114 — the Role a repository plays in a product. The options come from the
 * server's own list (`PRODUCT_REPO_ROLES`), so the form can only offer a value
 * the API accepts; the page once kept its own list and four of its eight
 * options were answered with a 400.
 */
import { PRODUCT_REPO_ROLES, type ProductRepoRole } from "@metis/shared";

/** A label per role; typed over the shared list, so a new role needs one here. */
const REPO_ROLE_LABELS: Record<ProductRepoRole, string> = {
  frontend: "Frontend",
  "backend-api": "Backend API",
  "shared-lib": "Shared library",
  microservice: "Microservice",
  gateway: "Gateway",
  docs: "Docs",
};

/** The label for a stored role; a value outside the list is shown as stored. */
export function repoRoleLabel(role: string): string {
  return REPO_ROLE_LABELS[role as ProductRepoRole] ?? role;
}

export function RepoRoleSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: ProductRepoRole;
  onChange: (role: ProductRepoRole) => void;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as ProductRepoRole)}
      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {PRODUCT_REPO_ROLES.map((role) => (
        <option key={role} value={role}>
          {REPO_ROLE_LABELS[role]}
        </option>
      ))}
    </select>
  );
}
