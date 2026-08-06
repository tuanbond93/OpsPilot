# Performance Audit

This document audits the performance profile of OpsPilot, identifying bottlenecks across databases, RPCs, loops, projections, planners, dashboards, and sync routines.

---

## Estimated Bottlenecks

### 1. Synchronous Supabase Writes in Sync Ingestion
*   **Bottleneck**: In [`src/jobs/sync-rillnet.ts`](file:///d:/Project/OpsPilot/src/jobs/sync-rillnet.ts), when inserting snapshots and incidents:
    - Snapshots are written in batches of 500 (`persistSnapshots`).
    - Incidents are written sequentially or in a single large upsert block (`persistIncidents`).
*   **Performance Impact**: Under heavy loads (>10,000 orders), network round-trips to Supabase can take up to 4–6 seconds, blocking the node event loop.
*   **Recommendation**: Implement asynchronous worker queues or Supabase bulk COPY commands to ingest raw data in parallel.

### 2. Parallel API Query Blowout (Dashboard Route)
*   **Bottleneck**: [`src/app/api/dashboard/route.ts`](file:///d:/Project/OpsPilot/src/app/api/dashboard/route.ts) fires 9 concurrent Supabase client requests using `Promise.all()`.
*   **Performance Impact**: In production, Supabase / Postgres connection pools can be exhausted quickly under concurrent user requests, introducing query latency (up to 1.5 seconds per request).
*   **Recommendation**: Cache the aggregated dashboard JSON payload in a Node-Cache store with a short TTL (e.g. 5 seconds) instead of re-querying all tables.

### 3. N+1 Query Risks in Projections
*   **Bottleneck**: Projections (`incident-projection.ts`, `warehouse-projection.ts`) load incident records, history logs, and followup states in bulk arrays, performing in-memory mappings.
*   **Performance Impact**: As history logs scale to millions of rows, loading them all for comparison will lead to Out-Of-Memory (OOM) crashes in the serverless functions.
*   **Recommendation**: Apply database-level pagination, query limits (`.limit(100)`), or compute metrics directly inside database views/triggers.

### 4. Deterministic State Machine Iterations
*   **Bottleneck**: State transitions in the Follow-up Engine map over thousands of incidents in memory.
*   **Performance Impact**: Loop overhead is small for JavaScript, but database lock contention during concurrent status changes can lead to query failures.
*   **Recommendation**: Apply state machine transitions inside a single PostgreSQL transactional block or database function.
