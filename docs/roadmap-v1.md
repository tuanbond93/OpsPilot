# OpsPilot Production Roadmap (v1.0)

This roadmap outlines the sprints required to guide OpsPilot from its current state to a hardened, enterprise-grade production environment.

---

## Future Sprint Roadmap

### Sprint 6.1: Security & Rate Limiting Hardening
*   **Goal**: Secure public API endpoints, protect background crons, and mitigate prompt injection vulnerabilities.
*   **Deliverables**:
    - Implement Bearer Token Authorization check header on all `/api/cron/*` and `/api/system/*` routes.
    - Set up API rate-limiting middleware for Next.js to restrict concurrent dashboard queries.
    - Escape customer/operator note strings inside `RootCauseAgent` and `ActionPlanner` prompts.
*   **Estimated Effort**: 3 days
*   **Business Value**: Prevents unauthorized API access, controls operational AI API costs, and blocks injection attacks.

### Sprint 6.2: Performance Tuning & Caching
*   **Goal**: Reduce dashboard API load and minimize database connection pool exhaustion.
*   **Deliverables**:
    - Integrate a Node-Cache store with a 5-second TTL for the parallel summary data fetched in `GET /api/dashboard`.
    - Apply pagination and limits (`limit(50)`) to `incident_history` queries to avoid memory blowout.
*   **Estimated Effort**: 3 days
*   **Business Value**: Decreases page load time to <300ms, saves Supabase database compute resources.

### Sprint 7: decoupling Repositories & Fallbacks
*   **Goal**: Eliminate the mixing of mock fallback logic inside production repositories.
*   **Deliverables**:
    - Abstract the repository classes (e.g. `IAiJobRepository`, `IPlannerRepository`).
    - Create a clean separation between the database-driven Supabase repositories and the offline/in-memory mocks.
    - Inject the correct repository implementation based on the environment configuration profile.
*   **Estimated Effort**: 5 days
*   **Business Value**: Ensures strict production failures (no silent mocks in prod) while keeping test environments offline.

### Sprint 8: Asynchronous Ingestion & Queuing
*   **Goal**: Scale the Rillnet synchronization pipeline for large warehouse datasets.
*   **Deliverables**:
    - Decouple `syncRillnet` from the Next.js API thread.
    - Introduce background queuing (using Upstash, Redis, or Supabase Edge Workers) to ingest snapshots asynchronously.
*   **Estimated Effort**: 7 days
*   **Business Value**: Supports scaling to hundreds of thousands of daily order snapshots without timeouts.

### Sprint 9: Real-time Pub/Sub Optimization
*   **Goal**: Polish UI responsiveness with real-time warehouse incidents dashboard push notifications.
*   **Deliverables**:
    - Connect the Next.js UI component pages directly to Supabase Real-time broadcast channels.
    - Optimize the `RealtimePublisher` client to only push lightweight change signals instead of heavy metric bodies.
*   **Estimated Effort**: 5 days
*   **Business Value**: Enhances operator efficiency with sub-second incident updates without dashboard polling.
