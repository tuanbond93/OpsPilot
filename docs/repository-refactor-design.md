# Repository Refactor Design

This document details the architectural design for refactoring the OpsPilot repository layer. The primary goal is to establish interface boundaries, decouple production query paths from test mock fallbacks, and design a robust dependency injection strategy to maximize testability.

---

## 1. Review of Current Repositories

In the current codebase, repositories (such as `AiJobRepository`, `PlannerRepository`, `FollowupRepository`) combine multiple responsibilities in a single class:
1.  **Database Connection Checks**: Verifying whether the Supabase client exists.
2.  **Fallback Evaluation**: Querying `isFallbackAllowed()` to check `NODE_ENV` or environment overrides.
3.  **In-Memory Storage**: Managing arrays of mock objects (`inMemoryJobs`, `inMemoryQueue`) on the production class instance.
4.  **SQL Database Queries**: Executing Supabase select, update, and RPC actions.

This causes high coupling, increases the risk of test configurations leaking into production runtimes, and violates the Single Responsibility Principle.

---

## 2. Separation of Responsibilities

To achieve a clean architecture, we decouple the layer into four distinct components:

| Component | Responsibility | Examples |
| :--- | :--- | :--- |
| **Connector** | Raw client instantiations and network wrapper setups. | `createAdminClient()`, `TelegramClient` |
| **Repository** | Data mapping between domain models and database records. Contains purely database queries. | `SupabaseIncidentRepository` |
| **Mock Implementation** | Completely offline, in-memory collection stores simulating database operations for testing. | `InMemoryIncidentRepository` |
| **Service** | Orchestrates transaction scopes, business validations, and links multiple repository updates. | `IncidentService`, `SyncService` |

---

## 3. Interface Definitions

Every repository is mapped to a strict TypeScript interface to facilitate mock swapping during tests.

### `IIncidentRepository`
```typescript
import type { IncidentRow } from "@/connectors/supabase/types";

export interface IIncidentRepository {
  getById(id: string): Promise<IncidentRow | null>;
  getActiveIncidents(scope?: string): Promise<IncidentRow[]>;
  upsertIncidents(incidents: Partial<IncidentRow>[]): Promise<IncidentRow[]>;
  resolveAbsentIncidents(presentIds: string[], completedAt: string): Promise<void>;
}
```

### `IFollowupRepository`
```typescript
import type { FollowupCaseRow, FollowupEventRow } from "@/connectors/supabase/types";

export interface IFollowupRepository {
  getCaseByIncidentId(incidentId: string): Promise<FollowupCaseRow | null>;
  upsertCase(caseData: Partial<FollowupCaseRow>): Promise<FollowupCaseRow>;
  appendTransitionEvent(event: Omit<FollowupEventRow, "id" | "created_at">): Promise<FollowupEventRow>;
  getRecentEvents(limit?: number): Promise<FollowupEventRow[]>;
}
```

### `IPlannerRepository`
```typescript
import type { PlannerRunRow, PlannerReviewEventRow } from "@/connectors/supabase/types";

export interface IPlannerRepository {
  getLatestRunByIncidentId(incidentId: string): Promise<PlannerRunRow | null>;
  createRun(run: Partial<PlannerRunRow>): Promise<PlannerRunRow>;
  updateRunStatus(id: string, status: string, extra?: any): Promise<PlannerRunRow>;
  appendReviewEvent(event: Omit<PlannerReviewEventRow, "id" | "created_at">): Promise<PlannerReviewEventRow>;
  getRecentReviewEvents(limit?: number): Promise<PlannerReviewEventRow[]>;
}
```

### `IAiJobRepository`
```typescript
import type { AiAnalysisJobRow } from "@/connectors/supabase/types";

export interface IAiJobRepository {
  enqueueJob(incidentId: string, priority: string, scheduledAt?: string): Promise<AiAnalysisJobRow>;
  claimPendingJob(workerId: string, lockTimeoutMs?: number): Promise<AiAnalysisJobRow | null>;
  markJobCompleted(jobId: string): Promise<AiAnalysisJobRow | null>;
  markJobFailed(jobId: string, errorMsg: string, retryDelaySeconds?: number, permanent?: boolean): Promise<AiAnalysisJobRow | null>;
  getPendingJobByIncidentId(incidentId: string): Promise<AiAnalysisJobRow | null>;
  getAllJobs(limit?: number): Promise<AiAnalysisJobRow[]>;
}
```

### `INotificationRepository`
```typescript
import type { NotificationActionRow, NotificationActionEventRow } from "@/engine/action-queue/types";

export interface INotificationRepository {
  enqueueAction(action: Partial<NotificationActionRow>): Promise<NotificationActionRow>;
  claimActions(workerId: string, limit?: number): Promise<NotificationActionRow[]>;
  updateActionStatus(id: string, status: string, extra?: any): Promise<NotificationActionRow | null>;
  appendActionEvent(event: Omit<NotificationActionEventRow, "id" | "created_at">): Promise<NotificationActionEventRow>;
  getRecentActionEvents(limit?: number): Promise<NotificationActionEventRow[]>;
}
```

### `ISyncRunRepository`
```typescript
import type { SyncRunRow } from "@/connectors/supabase/types";

export interface ISyncRunRepository {
  getLatestSyncRun(): Promise<SyncRunRow | null>;
  createSyncRun(syncRun: Partial<SyncRunRow>): Promise<SyncRunRow>;
  updateSuccess(id: string, metrics: any): Promise<SyncRunRow>;
  updateFailed(id: string, errorInfo: any): Promise<SyncRunRow>;
}
```

### `IWarehouseRepository`
```typescript
import type { WarehouseRow } from "@/connectors/supabase/types";

export interface IWarehouseRepository {
  getAll(): Promise<WarehouseRow[]>;
  getById(id: string): Promise<WarehouseRow | null>;
}
```

---

## 4. Dependency Injection Strategy

We implement a simple, lightweight registry pattern using a **Repository Factory** to inject dependencies at runtime. This avoids bulky IoC frameworks while preserving testability.

### The Repository Factory (`src/connectors/supabase/repository-factory.ts`)
```typescript
import { isFallbackAllowed } from "./fallback-policy";
import { createAdminClient } from "./server";

// Interfaces
import type { IIncidentRepository } from "./interfaces/IIncidentRepository";

// Implementations
import { SupabaseIncidentRepository } from "./repositories/supabase/IncidentRepository";
import { InMemoryIncidentRepository } from "./repositories/memory/IncidentRepository";

class RepositoryFactory {
  private static incidentRepoInstance: IIncidentRepository | null = null;

  static getIncidentRepository(): IIncidentRepository {
    if (this.incidentRepoInstance) return this.incidentRepoInstance;

    try {
      const client = createAdminClient();
      this.incidentRepoInstance = new SupabaseIncidentRepository(client);
    } catch (err) {
      if (isFallbackAllowed()) {
        this.incidentRepoInstance = new InMemoryIncidentRepository();
      } else {
        throw err;
      }
    }
    return this.incidentRepoInstance;
  }

  // Setters for test mocking (stub injection)
  static setIncidentRepository(repo: IIncidentRepository): void {
    this.incidentRepoInstance = repo;
  }

  static clear(): void {
    this.incidentRepoInstance = null;
  }
}
```

---

## 5. New Folders Architecture

```
src/
└── connectors/
    └── supabase/
        ├── interfaces/                  # Strict repository contract files
        │   ├── IIncidentRepository.ts
        │   ├── IAIJobRepository.ts
        │   └── ...
        ├── repositories/
        │   ├── supabase/                # Pure database implementations
        │   │   ├── IncidentRepository.ts
        │   │   └── ...
        │   └── memory/                  # Offline mock stores (for Vitest/development)
        │       ├── IncidentRepository.ts
        │       └── ...
        ├── fallback-policy.ts
        ├── repository-factory.ts         # Runtime IoC Factory resolver
        ├── server.ts
        └── types.ts
```

---

## 6. Refactoring Migration Steps

To minimize breaking changes and keep CI checks passing at all times, the refactoring is planned in five incremental steps:

1.  **Define Interfaces & Folder Structures**:
    - Create the `interfaces` and `repositories` sub-folders.
    - Write the interface file contracts (non-breaking, zero code impact).
2.  **Split InMemory Mocks**:
    - Extract the in-memory array code from the current repositories and write them into the `repositories/memory` folder matching their new interface contract.
3.  **Harden Database Implementations**:
    - Port the remaining database query logics into `repositories/supabase` and implement the matching interfaces.
4.  **Integrate RepositoryFactory**:
    - Write the `repository-factory.ts` file.
    - Replace direct imports of repository classes in API routes and jobs (e.g. `new AiJobRepository(client)`) with call resolving factories (e.g. `RepositoryFactory.getAiJobRepository()`).
5.  **Clean up Test Mocks**:
    - Update Vitest suites to use `RepositoryFactory.setIncidentRepository(new MockRepository())` instead of spying on database client functions, keeping tests isolated.
