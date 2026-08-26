# OpsPilot authentication and RBAC

## Production switch

Set `AUTH_ENFORCEMENT_ENABLED=true` only after every operator has a Supabase Auth account and an administrator has assigned `app_metadata.opspilot_role`. Accepted roles are `OPERATOR`, `REVIEWER`, `MANAGER`, and `ADMIN`. Do not rely on user-editable profile fields for production authorization.

## Permission model

| Capability | OPERATOR | REVIEWER | MANAGER | ADMIN |
| --- | --- | --- | --- | --- |
| View operational data | Yes | Yes | Yes | Yes |
| Verify incident / submit feedback | Yes | Yes | Yes | Yes |
| Process pilot feedback | No | Yes | Yes | Yes |
| Confirm follow-up | No | Yes | Yes | Yes |
| Review Copilot / Planner | No | Yes | Yes | Yes |
| Manage Decision / record outcome | No | No | Yes | Yes |
| Export learning data | No | No | Yes | Yes |
| Manual sync / notification controls / generate Planner | No | No | No | Yes |

The server derives the audit actor from the authenticated session. Actor names supplied in a request body are ignored while authentication enforcement is active.

## Defense in depth

- Middleware protects operational pages and APIs and redirects unauthenticated page requests to `/account`.
- Mutation routes independently validate permission, JSON shape, origin, payload size, and a bounded per-process rate limit.
- Debug reads require authentication. Debug mutations map to the narrowest permission.
- `CRON_SECRET` is an alternative identity only for scheduled sync endpoints; it does not grant browser access.
- Browser responses include CSP, anti-framing, content-type, referrer, capability and cross-origin headers. HSTS is enabled in production.
- Authentication and authorization denials emit structured edge audit records with a correlation ID.

## Known production limits

- Rate limiting is process-local. Multi-instance production should use a shared limiter at the edge or in Redis.
- Role provisioning and revocation are managed in Supabase; OpsPilot has no administrator user-management console yet.
- Security audit events use structured application logs, not a dedicated immutable database table.
- `ENABLE_DASHBOARD_WRITE_CONTROLS` and `ALLOW_MANUAL_ACTION_CONFIRM` remain separate safety switches even for authorized roles.

## Rollout verification

1. Test one account for every role on `/account`.
2. Verify OPERATOR receives 403 on review, Decision and system-control APIs.
3. Verify REVIEWER can review and confirm follow-up but cannot run sync.
4. Verify MANAGER can manage Decision and export learning data but cannot run sync.
5. Verify ADMIN can run explicitly enabled system controls.
6. Sign out and verify operational pages redirect to `/account`.
7. Review hosting logs for `AUTHENTICATION_REQUIRED` and `PERMISSION_DENIED` events.
