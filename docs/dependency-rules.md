# OpsPilot Architectural Dependency Rules

To maintain long-term maintainability, testability, and decoupling, all code in OpsPilot MUST adhere to the following dependency boundaries:

## 1. Service Layer Rules
- Services MUST NOT import `next/*` or `next/server`.
- Services MUST NOT import `@supabase/supabase-js`.
- Services MUST NOT import `@/connectors/supabase/*`.
- Services MUST NOT import `@/repositories/RepositoryFactory`.
- Services MUST NOT import concrete repository classes (`@/repositories/supabase/*` or `@/repositories/mock/*`).
- Services MUST accept all data access and adapter dependencies strictly via constructor injection.

## 2. Transport Layer Rules (API Routes & Jobs)
- Routes and cron jobs MUST NOT contain database queries or business orchestration.
- Routes and cron jobs MUST NOT import concrete repository classes directly.
- Routes and cron jobs MUST obtain services via `ServiceFactory.getService(client)`.

## 3. Repository Layer Rules
- Repositories MUST NOT import service layer implementations or interfaces.
- Repositories MUST isolate Supabase client query builder operations behind repository interface contracts (`IRepository`).
