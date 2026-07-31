import type { StaffRole } from "../db";

/**
 * Role → permission map (§16).
 *
 * Server-side truth. `docs/API.md` §16 is explicit that "the UI role model
 * mirrors but never substitutes for" this, and §22 rule 4 that humans, agents,
 * and tokens are checked identically — an agent can never do something the staff
 * member behind it could not.
 *
 * Permissions are coarse and domain-shaped rather than per-endpoint. A list with
 * one entry per route is impossible to reason about at review time, which is how
 * over-permissive roles ship.
 */

export const PERMISSIONS = [
  "catalog.read",
  "catalog.write",
  "commerce.read",
  "commerce.write",
  "analytics.read",
  "cms.read",
  "cms.write",
  "billing.read",
  "billing.write",
  "org.read",
  "org.write",
  /** Manage staff, invitations, and roles. Separate from `org.write`: editing the
   *  billing email is not the same authority as granting someone access. */
  "org.staff",
  /** Create and revoke scoped API/MCP tokens (§22 rule 6). */
  "tokens.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const READ_ONLY: Permission[] = [
  "catalog.read",
  "commerce.read",
  "analytics.read",
  "cms.read",
  "org.read",
];

const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  /** Owns the org and its billing. The only role that can hand ownership on. */
  owner: PERMISSIONS,

  /**
   * Everything operational, including billing. Distinguished from owner by what
   * lives outside this map — ownership transfer and org deletion check
   * `org.ownerId` directly, not a permission, so an administrator cannot grant
   * themselves the org.
   */
  administrator: PERMISSIONS,

  catalog_manager: [...READ_ONLY, "catalog.write"],

  commerce_manager: [...READ_ONLY, "commerce.write"],

  /** Reporting only — deliberately no write anywhere. */
  analyst: READ_ONLY,

  /**
   * Builds with custom code and integrations. Gets `cms.write` and tokens, but
   * no authority over money or customer data beyond reading it.
   */
  developer: [...READ_ONLY, "cms.write", "tokens.manage"],

  viewer: READ_ONLY,
};

export function permissionsForRole(role: StaffRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: StaffRole, permission: string): boolean {
  return (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);
}

/** Only the org owner may transfer ownership or delete the org — never a role grant. */
export function isOrgOwner(org: { ownerId: string }, userId: string): boolean {
  return org.ownerId === userId;
}
