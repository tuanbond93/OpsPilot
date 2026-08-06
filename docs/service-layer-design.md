# Service Layer Design Document

The Service Layer acts as the central business orchestrator for OpsPilot.

## Migrated Services

1. **`DashboardService`**: Aggregates incident KPIs, warehouse scope filtering, write-control governance, and health metadata.
2. **`AiWorkerService`**: Claims pending AI queue items, manages lock leases, runs AI analysis (`RootCauseAgent` & `ActionPlannerAgent`), and persists results.
3. **`NotificationService`**: Processes pending notification actions, enforces retry policies, dispatches via channel providers (Console, Telegram), and links follow-up state confirmations.
4. **`SyncService`**: Orchestrates snapshots from Rillnet, order normalization, warehouse persistence, incident detection, follow-up state machine evaluation, and read-model projection refreshes.
5. **`PlannerService`**: Handles plan generation, root-cause context building, draft caching, idempotency validation, and immutable review event persistence.
6. **`FollowupService`**: Coordinates state machine transitions (`FIRST_PUSH`, `SECOND_PUSH`, `ESCALATION`), case detail retrieval, manual action confirmations, and notification action state linkages.
7. **`IncidentService`**: Manages open incident queries, live snapshot fallbacks, timeline history formatting, and root-cause analysis execution.
8. **`ProjectionService`**: Coordinates read-model projection refreshes (`warehouse_summary`, `incident_summary`, `planner_summary`, `notification_summary`) in parallel via projection port interfaces (`IWarehouseProjection`, `IIncidentProjection`, `IPlannerProjection`, `INotificationProjection`).
