# Adaptive V2 real shadow replay — baseline contract

`AdaptiveCaseSnapshot` is the only retained-production-evidence boundary for replay. `snapshotCaseAt` filters every history, action, event, exception, commitment, and ETA fact to `<= observedAt`; it never reads mutable current follow-up state as historic fact. Missing source data remains null/unknown and lowers quality to `PARTIAL` or `HISTORICAL_STATE_UNAVAILABLE`.

The unchanged V2 core receives an in-memory projection of this snapshot. Structured trusted operational ETA (A) and structured operator ETA (B) may support a V2 wait. Derived/unstructured ETA (C/D) cannot. A commitment must have durable actor/source, recorded time, and non-expired completion time; the current retained evidence reader exposes no such commitment source, so live commitment evidence is unsupported.

V1 reconstruction uses dated `followup_events` only. Its policy-version provenance is not retained, so every non-unknown reconstruction is `PARTIAL`; it is never presented as an exact historic policy proof. The current reader has no trustworthy SLA deadline, ETA, route, driver, or operator-response source, making initial retained-evidence replay partial rather than fit for a production conclusion.

The pure replay harness makes a per-case V1/V2 comparison and reviews waits against subsequent retained history up to the proposed next check. A `V2_POTENTIAL_MISS` is kept explicit whenever V1 would act while V2 waits without a trusted progress/ETA/commitment basis. Outcomes say only what was observed after an intervention; no causal attribution is made.

No live production query is run by this code, no endpoint is exposed, and no shadow decision is persisted. A future live shadow store must be isolated and contain decision id, case id, observation time, V1/V2 decisions, risk/reason, next check, confidence, snapshot hash, engine version, and policy version.
