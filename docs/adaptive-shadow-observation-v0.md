# Adaptive Shadow Observation Layer V0

This build adds pure, versioned contracts only. It does not create a database migration, runtime hook, API route, cron entry, notification, queue item, or production write.

`AdaptiveObservationSnapshot`, `CheckpointCaseSnapshot`, `AdaptiveShadowDecisionRecord`, and `ShadowOutcomeObservation` are append-only schemas. Unknown source values remain `null`/`UNKNOWN`; `appendObservation` rejects replacement of an existing snapshot ID in local fixtures. A future durable store must enforce the same unique-ID and insert-only constraints.

The source registry is in `registry.ts`. It distinguishes signals currently exposed by retained evidence from type-only aspirations: backlog, exception, confirmed intervention, and resolution are available; exact SLA, structured ETA, route, driver, commitment, and normalized operator response are not.

The normalizers use structured evidence only. They do not parse free text. Expired or weak ETA cannot be used as trusted progress. A commitment needs actor, recorded time, completion time, and source; conflicting commitments are ambiguous.

## Future failure isolation

The intended runtime is `V1 checkpoint → append observation → V2 shadow decision → append shadow decision`. V1 finishes first. Shadow exceptions are swallowed and recorded as shadow failure in a future isolated store; they cannot enqueue notifications, mutate cases, or change V1's result. The generic composition proof is local-only and is deliberately not wired into V1.

The only feature flags proposed are `ADAPTIVE_V2_SHADOW_ENABLED` and `SHADOW_SNAPSHOT_WRITE_ENABLED`, both default false. There is intentionally no V2 action-mode or dispatch flag.

## Retention estimate

Planning upper bound: three snapshots, three decisions, and three outcome observations per active case/day (nine rows/case/day).

| Active cases/day | Rows/day | Rows/month (30d) |
| ---: | ---: | ---: |
| 100 | 900 | 27,000 |
| 500 | 4,500 | 135,000 |
| 1,000 | 9,000 | 270,000 |
| 5,000 | 45,000 | 1,350,000 |

Keep 90 days hot for audit/replay; archive append-only records for 12 months, partitioned by observation month and warehouse/region where supported. This is a capacity estimate, not a production retention change.
