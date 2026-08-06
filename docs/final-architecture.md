# OpsPilot Final Architecture Guide

OpsPilot follows a clean 3-tier architecture with explicit Factory orchestration, Interface Segregation, and strict dependency boundaries.

```
Transport Layer (Next.js API Routes / Cron Jobs)
       │
       ▼
Service Factory (ServiceFactory)
       │
       ▼
Service Layer (src/services/impl/*)
       │
       ▼
Repository Factory (RepositoryFactory) / Port Adapters
       │
       ▼
Repository Interfaces & Persistence Adapters (src/repositories/* & src/connectors/*)
       │
       ▼
Database (Supabase PostgreSQL / External APIs)
```

## Layer Responsibilities

1. **Transport Layer (`src/app/api/*`, `src/jobs/*`)**
   - HTTP request parsing, query parameters, route parameters.
   - Authentication context / environment security checks.
   - Thin delegation to `ServiceFactory.getXService()`.
   - `NextResponse.json` status code and payload formatting.

2. **Service Layer (`src/services/impl/*`)**
   - Pure domain orchestration and business logic.
   - Depends **ONLY** on interface abstractions (`IRepository`, `IActionQueue`, Projection Port Interfaces).
   - Zero framework imports (`next/*`), database SDK imports (`@supabase/supabase-js`), or concrete repository classes.

3. **Repository & Adapter Layer (`src/repositories/*`, `src/connectors/*`, `src/projections/adapters/*`)**
   - Data access, Supabase RPC calls, query builder operations, external API integration (`RillnetConnector`).
   - Managed via `RepositoryFactory` for DI and fallback policy switching.

4. **Engine & Agent Layer (`src/engine/*`, `src/agents/*`)**
   - Deterministic rule engine evaluation (Follow-up State Machine, Incident Aggregator).
   - Autonomous AI Agents (`RootCauseAgent`, `ActionPlannerAgent`).
