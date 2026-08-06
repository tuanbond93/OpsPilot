# OpsPilot Decisions Log

*(append‑only log of implementation decisions)*

---

**Decision ID:** DEC‑001
**Date:** UNKNOWN
**Title:** Progress‑percent clamping
**Status:** REJECTED
**Context:** Follow‑up progress percent stored as NUMERIC(5,2)
**Options Considered:** Clamp value to 99.99 or expand column precision
**Decision:** Reject clamping; expand PostgreSQL column precision
**Reason:** Clamping loses information; column can be safely expanded
**Consequences:** Migration 013 required to increase precision
**Revisit Conditions:** None
**Related Sprint:** UNKNOWN
**Related ADR:** ADR‑006 (Batch Followup Processing)
**Related Issue:** FOLLOWUP‑001

**Decision ID:** DEC‑002
**Date:** UNKNOWN
**Title:** PostgreSQL session advisory lock
**Status:** REJECTED
**Context:** Need distributed sync locking across Supabase/PostgREST connections
**Options Considered:** Session advisory lock vs lock‑row RPC
**Decision:** Reject advisory lock; use atomic lock‑row RPC compatible with pooling
**Reason:** Session locks not preserved across pooled connections
**Consequences:** New lock implementation required
**Revisit Conditions:** None
**Related Sprint:** 10.5
**Related ADR:** ADR‑008 (Cross‑Process Sync Resume)
**Related Issue:** SYNC‑001

**Decision ID:** DEC‑003
**Date:** UNKNOWN
**Title:** Persisting raw Rillnet snapshot bodies
**Status:** REJECTED
**Context:** Storing raw Rillnet bodies in PostgreSQL for later replay
**Options Considered:** Store raw bodies vs re‑download before safe boundary
**Decision:** Reject raw persistence; re‑download before safe persistence boundary and use deterministic replay
**Reason:** Raw bodies large and brittle; replay ensures integrity
**Consequences:** Additional network fetch on retry
**Revisit Conditions:** None
**Related Sprint:** 10.2
**Related ADR:** None
**Related Issue:** RILLNET‑001

**Decision ID:** DEC‑004
**Date:** UNKNOWN
**Title:** Safe replay when intermediate state cannot be rehydrated
**Status:** ACCEPTED
**Context:** Need deterministic replay for missing state
**Decision:** Use safe replay instead of skipping phases
**Reason:** Guarantees correctness without data loss
**Consequences:** Requires replay infrastructure
**Revisit Conditions:** None
**Related Sprint:** 10.4.1
**Related ADR:** ADR‑008 (Cross‑Process Sync Resume)
**Related Issue:** SYNC‑001

**Decision ID:** DEC‑005
**Date:** UNKNOWN
**Title:** Projection port interfaces isolating raw Supabase clients
**Status:** ACCEPTED
**Context:** ProjectionService directly used raw Supabase client
**Decision:** Introduce projection port interfaces and Supabase adapters
**Reason:** Improves testability and decouples architecture
**Consequences:** Refactor ProjectionService
**Revisit Conditions:** None
**Related Sprint:** 8.10
**Related ADR:** ADR‑005 (Projection Layer)
**Related Issue:** PROJECTION‑001
