# OpsPilot Known Issues

## Fixed Issues

- **Issue ID:** RILLNET-001
  **Title:** Rillnet response-body timeout
  **Status:** FIXED
  **Introduced:** Sprint 10.1.1
  **Resolved Sprint:** 10.1.1
  **Root Cause:** Body read can stall beyond timeout, causing AbortController.
  **Impact:** Potential hanging downloads.
  **Workaround:** None – fix applied.
  **Permanent Fix:** Implement timeout handling and abort signal.
  **Evidence:** `src/__tests__/rillnet-body-timeout.test.ts` validates timeout behavior.
  **Related ADR:** None
  **Related Decision:** None

- **Issue ID:** RILLNET-002
  **Title:** Signed URL expiration/retry limitation
  **Status:** FIXED
  **Introduced:** Sprint 10.2
  **Resolved Sprint:** 10.2
  **Root Cause:** Expired signed URLs cause 403 errors; retry policy not handling.
  **Impact:** Failed snapshot downloads.
  **Workaround:** None – retry policy updated.
  **Permanent Fix:** Refresh signed URL on retry.
  **Evidence:** `src/__tests__/rillnet-resilience.test.ts` covers retry logic.
  **Related ADR:** None
  **Related Decision:** None

- **Issue ID:** FOLLOWUP-001
  **Title:** Follow-up progress NUMERIC(5,2) overflow
  **Status:** FIXED
  **Introduced:** UNKNOWN (migration 013)
  **Resolved Sprint:** UNKNOWN
  **Root Cause:** Column size too small for progress percent.
  **Impact:** Data truncation.
  **Workaround:** None – migration expands column.
  **Permanent Fix:** Migration `013_fix_followup_progress_percent_numeric.sql`.
  **Evidence:** Migration applied in CI.
  **Related ADR:** None
  **Related Decision:** Rejected clamping; expanded schema.

- **Issue ID:** SYNC-001
  **Title:** Missing cross-process state rehydration
  **Status:** FIXED
  **Introduced:** Sprint 10.4.1
  **Resolved Sprint:** 10.4.1
  **Root Cause:** Process restart lost sync state.
  **Impact:** Incomplete sync runs.
  **Workaround:** None – state persisted.
  **Permanent Fix:** Persist phase checkpoints and rehydrate.
  **Evidence:** `src/__tests__/cross-process-sync.test.ts` validates recovery.
  **Related ADR:** ADR-008 (Cross-Process Sync Resume).
  **Related Decision:** Use safe replay when state cannot be rehydrated.

- **Issue ID:** FOLLOWUP-002
  **Title:** Sequential follow-up persistence bottleneck
  **Status:** FIXED
  **Introduced:** Sprint 10.1
  **Resolved Sprint:** 10.1
  **Root Cause:** Follow-up cases persisted one-by-one.
  **Impact:** Slow batch processing.
  **Workaround:** None – batching added.
  **Permanent Fix:** Batch upsert implementation.
  **Evidence:** `src/__tests__/followup-batching.test.ts`.
  **Related ADR:** ADR-006 (Batch Followup Processing).
  **Related Decision:** None

- **Issue ID:** ACTIONQUEUE-001
  **Title:** Sequential ActionQueue persistence bottleneck
  **Status:** FIXED
  **Introduced:** Sprint 10.3
  **Resolved Sprint:** 10.3
  **Root Cause:** ActionQueue persisted actions individually.
  **Impact:** Performance degradation.
  **Workaround:** None – batching added.
  **Permanent Fix:** Batch ActionQueue persistence.
  **Evidence:** `src/__tests__/action-queue-batch.test.ts`.
  **Related ADR:** ADR-007 (Batch ActionQueue).
  **Related Decision:** None

- **Issue ID:** PROJECTION-001
  **Title:** ProjectionService raw client boundary leak
  **Status:** FIXED
  **Introduced:** Sprint 8.10
  **Resolved Sprint:** 8.10
  **Root Cause:** Raw Supabase client used directly in ProjectionService.
  **Impact:** Tight coupling, testing difficulty.
  **Workaround:** None – projection ports introduced.
  **Permanent Fix:** Use projection ports to isolate raw client.
  **Evidence:** `src/__tests__/projection-service.test.ts`.
  **Related ADR:** ADR-005 (Projection Layer).
  **Related Decision:** Use projection ports to stop raw clients.

## Open Issues

*None.*
