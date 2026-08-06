# Technical Debt Register

This document registers and ranks all technical debt items in the OpsPilot codebase, providing effort estimates for resolution.

---

## Technical Debt Items

### 1. In-Memory Mock Fallbacks in Production Code
*   **Rank**: Critical
*   **Description**: Production repository classes mix database query logic with local memory fallbacks. If a Supabase client fails, it silently operates in memory. This masks configuration errors in production.
*   **Effort Estimate**: High (~3-5 days)
*   **Recommendation**: Separate fallbacks into explicit mock implementation files, injecting them only during development/test profiles.

### 2. Missing Database Indexes on Read Tables
*   **Rank**: High
*   **Description**: Tables like `sync_runs`, `order_snapshots`, `incident_history`, and `followup_events` do not have explicit indexes on columns like `incident_id`, `created_at`, or `status` in the schema migrations.
*   **Effort Estimate**: Low (~0.5 days)
*   **Recommendation**: Write SQL migrations to add indexes to all query columns.

### 3. Lack of Rate Limiting and Route Protection
*   **Rank**: High
*   **Description**: Public API endpoints (e.g. `/api/dashboard`, `/api/cron/*`) have no request throttling, allowing potential denial of service (DoS).
*   **Effort Estimate**: Medium (~1-2 days)
*   **Recommendation**: Integrate Next.js middleware rate limiting.

### 4. Monolithic Ingestion Job (`syncRillnet`)
*   **Rank**: Medium
*   **Description**: Ingestion processes too many sequential database writes and state transitions inside a single Next.js API timeout limit (usually 10-60 seconds on serverless hostings).
*   **Effort Estimate**: High (~4-6 days)
*   **Recommendation**: Delegate long-running sync tasks to serverless background workers or message queues.

### 5. Absence of Structured JSON Validation
*   **Rank**: Low
*   **Description**: Request body parameter checks are performed using ad-hoc `if` checks rather than declarative schemas.
*   **Effort Estimate**: Medium (~1 day)
*   **Recommendation**: Standardize request validation using `Zod` schemas.
