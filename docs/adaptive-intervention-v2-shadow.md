# Adaptive Intervention Engine V2 — shadow contract

V2 is a deterministic, side-effect-free proposal engine. It consumes a read-only case snapshot and returns a decision record; it neither imports nor invokes Follow-up Engine V1, notification dispatch, cron, or Supabase writes.

Its decisions are `ACT_NOW`, `WAIT`, `REQUEST_INFORMATION`, `ESCALATE`, and `CLOSE`. Every `WAIT` has a `nextCheckAt`; a checkpoint is only a re-evaluation opportunity, never an implied notification.

The policy is configured through `AdaptivePolicyConfig`, not fixed intervals scattered through the code. It treats valid exceptions, ETAs, commitments, material backlog progress, risk, prior confirmed interventions, and fatigue as distinct evidence. Missing evidence lowers confidence and returns `REQUEST_INFORMATION` unless a critical risk requires conservative action. Telegram evidence is not accepted by this module at all; a future reader must supply only case-linked durable confirmation.

`evaluateAdaptiveShadow` is the local fixture/read-snapshot harness. It outputs per-case V1/V2 comparisons and the requested summary counts. It has no production adapter and is not an API endpoint.

The future employee payload is `EmployeeTask`: a plain-language instruction with deadline and governed responses. The manager read model groups decisions as needs-action, waiting-with-plan, at-risk, escalation-required, resolved, or anomalous. Neither is a UI or dispatch contract yet.

Known boundary: the historical evidence reader does not yet reconstruct complete point-in-time case snapshots or operator commitments. A later read-only adapter must normalize those durable facts before any production-like shadow run. V2 is intentionally not deployed.
