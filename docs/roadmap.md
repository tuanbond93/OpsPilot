# OpsPilot Roadmap

Last Updated: 2026-08-06

## Current Sprint

- Sprint: 11.1
- State: IN PROGRESS

## Current Objective

**Metrics Runtime Optimization** – Reduce unnecessary database writes while preserving observable behavior.

## Next Recommended Sprint

**Sprint 11.2 – Full Metrics Persistence Optimization**
- Goal: Eliminate per‑request metric writes; persist only aggregated metrics.
- Reason: Current implementation writes a row for every metric update, causing high DB load.
- Deliverables:
  - Batch‑write layer for metrics.
  - Updated `MetricsService` to aggregate in‑memory and flush periodically.
  - Updated API schema (no payload change).
- Dependencies: Existing `MetricsService`, `IMetricsRepository`, and `system_metrics` table.
- Estimated Risk: Medium – requires careful handling of process crashes to avoid data loss.

## Future Backlog

1. **Sprint 11.3 – Introduce Prometheus Exporter** – Export metrics to Prometheus for real‑time monitoring.
2. **Sprint 12.0 – Distributed Circuit Breaker** – Implement global circuit breaker across services.
3. **Sprint 12.1 – Rillnet Response‑Body Timeout Handling** – Refine timeout strategy.

## Verified Blockers

None.

## Long‑Term Goals

- Evolve architecture toward event‑driven, loosely‑coupled services.
- Consolidate all observability into a unified telemetry layer.
- Gradual migration to serverless compute for scaling.
