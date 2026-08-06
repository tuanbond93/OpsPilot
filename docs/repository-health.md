# Repository Health Report

This report evaluates the code health of the OpsPilot codebase, identifying issues such as dead code, code duplication, large files/functions, and dependency issues.

---

## Identified Issues

### 1. Large Files (> 500 lines)
*   **File**: [`src/app/api/dashboard/route.ts`](file:///d:/Project/OpsPilot/src/app/api/dashboard/route.ts)
*   **Severity**: Medium
*   **Issue**: This API route is 573 lines long. It handles multiple concerns in parallel (fetching raw metrics from Supabase, processing timeline events, parsing risk fields, querying diagnostic health, and returning a complex JSON dashboard payload).
*   **Recommendation**: Extract the data transformation loops (mapping of timeline events, KPIs, and status calculations) into a separate service or utility file (e.g., `src/services/dashboard-mapper.ts`).

### 2. Large Functions (> 80 lines)
*   **File**: [`src/jobs/sync-rillnet.ts`](file:///d:/Project/OpsPilot/src/jobs/sync-rillnet.ts)
    *   **Function**: `syncRillnet`
    *   **Severity**: High
    *   **Issue**: The `syncRillnet` function is approximately 380 lines long. It manages the complete ingestion pipeline: establishing sync runs, fetching Rillnet snapshots, normalizing orders, building active incidents, persisting records, evaluating follow-up state machines, and running projections.
    *   **Recommendation**: Break the pipeline into discrete step functions (e.g., `fetchRillnetSnapshot`, `persistSyncRecords`, `processFollowupStateChange`).
*   **File**: [`src/app/api/dashboard/route.ts`](file:///d:/Project/OpsPilot/src/app/api/dashboard/route.ts)
    *   **Function**: `GET`
    *   **Severity**: Medium
    *   **Issue**: The dashboard `GET` handler is ~450 lines. It runs 9 database/repository queries in parallel, unpacks results, performs sorting, mapping, and calls components.
    *   **Recommendation**: Refactor into smaller sub-methods or query builders.

### 3. Duplicate Logic & Boilerplate
*   **File**: supabase repositories (`ai-job-repository.ts`, `planner-repository.ts`, `followup-repository.ts`, etc.)
*   **Severity**: Low
*   **Issue**: Each repository repeats database transaction try-catch boilerplate and `isFallbackAllowed()` branch checking for in-memory mocks.
*   **Recommendation**: Introduce a base abstract repository class (`BaseRepository`) that wraps Supabase table actions and manages local fallbacks automatically.

### 4. Dead Code / Unused Imports
*   **File**: Multiple codebase files
*   **Severity**: Low
*   **Issue**: Unused imports (e.g. `import { refresh } from "../projections/projection-engine"` commented out or diagnostic logs in `sync-rillnet.ts`) left behind after iterations.
*   **Recommendation**: Run ESLint automatic imports clean up command (`npx eslint --fix`).

### 5. Circular Imports Check
*   **File**: [`src/connectors/supabase/repositories/*` and `src/connectors/supabase/index.ts`](file:///d:/Project/OpsPilot/src/connectors/supabase/index.ts)
*   **Severity**: Low
*   **Issue**: Index files (`index.ts`) export all repositories, which are imported by other files that import the namespace. While TypeScript resolves this, it can lead to tight coupling.
*   **Recommendation**: Standardize direct imports of repositories instead of using circular module index files.
