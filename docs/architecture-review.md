# Architecture Review

This document reviews the architectural design of OpsPilot, assessing folders, dependencies, patterns, boundaries, and separation of concerns.

---

## Current Architecture

The codebase follows a hybrid Next.js Page/API structure and a modular backend architecture:

```
src/
├── agents/          # Autonomous AI agents (Root Cause, Action Planner)
├── ai/              # AI providers, wrappers (Gemini, OpenAI)
├── app/             # UI Pages and API Routes (Next.js App Router)
├── config/          # Configurations for SLA, Scheduler, Warehouses
├── connectors/      # Remote connection clients (Supabase, Rillnet, Telegram)
├── database/        # Seed files and SQL schema migrations
├── engine/          # Event store, follow-up engines, rule validators
├── integrations/    # Health checkers, scheduler runners, secret providers
├── jobs/            # AI background workers, notification dispatchers
└── projections/     # Read Model projection engine and processors
```

### Strengths

1.  **Strict Isolation of AI Providers**: The `src/ai` folder acts as an SDK wrapper around OpenAI and Gemini API endpoints, preventing leaks of vendor-specific APIs.
2.  **Clear Separations for Projections**: The `src/projections` directory isolates Read Model calculations, separating writes/normalizations from presentation models.
3.  **Resilient Offline Fallback Policy**: The repository pattern integrates an in-memory database mock fallback policy (`isFallbackAllowed`), enabling fully offline/test runs.

### Weaknesses

1.  **Tight Coupling in Repositories**: Repositories directly handle fallback logic and logs, making them heavier than standard data mappers.
2.  **Job Pipeline Monoliths**: Background jobs like `syncRillnet` integrate fetching, parsing, normalizations, state-machine transitions, and projections in a single procedure.
3.  **API Handler Presentation Overload**: The dashboard API handler maps database structures directly into client representations.

---

## Recommended Improvements

1.  **Extract Data Service Layer**: Introduce a Service Layer (`src/services/`) to encapsulate domain interactions, keeping jobs and API handlers slim.
2.  **Abstract Database Client Access**: Introduce an abstract factory pattern for `createAdminClient()` to avoid direct imports of `@supabase/supabase-js` outside of the connector layer.
3.  **Formalize Pipeline Middleware**: Implement a middleware/pipeline pattern for the sync engine to process ingest events sequentially.
