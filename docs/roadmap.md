# OpsPilot Roadmap

Last Updated: 2026-08-26

## Season 2 Level C Roadmap

North Star:

```text
REAL DATA → AUTO DETECT → AI RCA → AI OPTIONS → AI FINAL DECISION
→ DECISION CRITIC → HUMAN APPROVE/REJECT → EXECUTION
→ AUTO FOLLOW-UP → REAL OUTCOME → AUTO VERIFICATION
→ DECISION MEMORY → PnL / VERIFIED MONEY
```

Delivered and validated:

1. **LC-00:** repository audit and first-missing-link identification.
2. **LC-01:** deterministic Final Decision Engine with provenance and safe human-investigation disposition.
3. **LC-02:** independent Decision Critic with evidence/confidence/prerequisite checks.
4. **LC-03:** guarded recording of externally executed work; no autonomous operational action.
5. **LC-04:** automatic, immutable and idempotent Decision follow-up schedule after `EXECUTED`.
6. **LC-05:** immutable outcome-observation contract with a baseline snapshot, evidence requirements and measurement-window guard.
7. **LC-06:** deterministic Outcome Verifier from post-execution operational evidence, with abstention for incomplete policy/evidence.
8. **LC-07:** retrieval-only Decision Memory from verified outcomes, with explicit non-causal guard.

Next sequence:

1. **LC-08 — Financial Handoff:** send verified operational evidence to P15-B.1; do not calculate money inside Decision Core.

Frozen until company access exists: GHN Data API, MCP Gateway and GTalk. `AUTONOMOUS` mode and any new saving/cost semantics remain frozen.

> Implementation update (2026-08-23): Sprint 13 UI integration, review UX, executive control center, product polish, Decision Core, Pilot feedback/quality, learning-data export, and Supabase RBAC are implemented. Evidence-dependent work remains: accumulate representative pilot samples, close reviewed feedback, record observed Decision outcomes, and validate shared production rate limiting/log retention.

## Current Sprint

- Sprint: 12.4
- State: COMPLETED

## Current Objective

**Release Candidate, Production Closure & V1 Finalization** – Prove OpsPilot V1 is safe, recoverable, measurable, deployable, and release-ready. Completed final repository audit, database audit, production configuration checklist, health & startup verification, load/concurrency testing, failure recovery verification, rollback readiness documentation, security audit, final AI quality check, full validation suite execution, and V1 release readiness declaration.

## Next Recommended Sprint

**POST-V1 (Sprint 13.0+)**
- Goal: Post-V1 Operational Enhancements & Advanced Multi-Region Deployments.

## Future Backlog

1. **Sprint 13.1 – Multi-Region Database Replication & Active-Active Failover** – Regional database replication and automated failover routing.
2. **Sprint 13.2 – Automated Model Fine-Tuning Pipeline** – Direct fine-tuning dataset export for local LLM deployment.

## Verified Blockers

None.

## Long‑Term Goals

- Evolve architecture toward event‑driven, loosely‑coupled services.
- Consolidate all observability into a unified telemetry layer.
- Continual quality assessment through production human agreement metrics and supervised feedback datasets.
