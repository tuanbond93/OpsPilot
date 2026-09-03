/** A pilot manager can be an EMPLOYEE in the broader organization role model. */
export function canManageTelegramDecision(member: { role?: unknown; pilotRole?: unknown }) {
  return [member.role, member.pilotRole]
    .some((role) => ["MANAGER", "ADMIN"].includes(String(role || "").toUpperCase()));
}
