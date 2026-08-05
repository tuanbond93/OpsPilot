# OpsPilot Root Cause Agent Architecture & Specification

## 1. Purpose & Operational Boundaries
The **Root Cause Agent** ([`src/agents/root-cause/`](file:///d:/Project/OpsPilot/src/agents/root-cause/)) is an **evidence-grounded operational explanation agent**.

### Responsibilities
- Explain what is happening based strictly on deterministic Event Store data.
- Identify likely root causes grounded in typed evidence statements.
- Describe risk factors using a deterministic scoring engine.
- Expose system data limitations (e.g. missing staffing, vehicle, or route capacity data).
- Suggest safe investigation steps for field dispatchers.

### Non-Goals & Strict Constraints
- **NO Operational Commands**: The agent MUST NOT issue commands such as "Dispatch 2 shippers" or "Move vehicle A to B".
- **NO Fabricated Outcomes**: The agent MUST NOT promise arbitrary backlog reductions (e.g. "Backlog will drop by 50% in 4 hours").
- **NO Unverified Facts**: The agent MUST NOT infer staffing, vehicle, weather, or capacity shortages unless explicitly provided in context.

---

## 2. Pipeline Architecture
```text
┌────────────────────────┐
│   Event Store Data     │ (Persisted Incidents & History)
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│    Context Builder     │ (Calculates Trend, Duration, Progress)
└───────────┬────────────┘
            │
      ┌─────┴────────────────────┐
      ▼                          ▼
┌──────────────────┐    ┌──────────────────┐
│ Evidence Builder │    │ Risk Calculator  │
│ (Typed Statements│    │ (Deterministic   │
│  & Codes)        │    │  Score & Level)  │
└─────┬────────────┘    └────────┬─────────┘
      │                          │
      └───────────┬──────────────┘
                  ▼
┌────────────────────────────────┐
│        Root Cause Agent        │ (Calls AIProvider.generate())
└─────────────────┬──────────────┘
                  ▼
┌────────────────────────────────┐
│      Structured Output         │ (Validated & Sanitized JSON)
└────────────────────────────────┘
```

---

## 3. Deterministic Formulas & Rules

### Trend & Progress Formulas
- **Change Percentage**: \(\text{changePercent} = \frac{\text{currentCount} - \text{previousCount}}{\text{previousCount}} \times 100\%\)
- **Progress Classification**:
  - `strong_progress`: Reduction \(\ge 20\%\)
  - `limited_progress`: Reduction between \(5\%\) and \(20\%\)
  - `no_material_progress`: Change between \(-5\%\) and \(+5\%\)
  - `worsening`: Increase \(> 5\%\)
  - `insufficient_data`: Fewer than 2 history points

### Deterministic Risk Scoring Formula
- **Order Count Contribution**: 1–20 (+5), 21–50 (+10), 51–100 (+20), >100 (+30)
- **Maximum Age Contribution**: \(\ge 24h\) (+10), \(\ge 48h\) (+20), \(\ge 72h\) (+30) (Highest applicable only)
- **Trend Contribution**: Decreasing >20% (+0), Decreasing 1–20% (+5), Stable (+15), Increasing 1–20% (+20), Increasing >20% (+30)
- **Incident Duration Contribution**: \(\ge 4h\) (+5), \(\ge 8h\) (+10), \(\ge 24h\) (+20)
- **Total Score**: Capped at 100.
- **Risk Level**: 0–24 (`low`), 25–49 (`medium`), 50–74 (`high`), 75–100 (`critical`).

---

## 4. Structured Output Schema & Evidence Codes

### Schema Definition ([`schema.ts`](file:///d:/Project/OpsPilot/src/agents/root-cause/schema.ts))
```typescript
interface RootCauseResult {
  summary: string;
  assessment: {
    status: "improving" | "stagnant" | "worsening" | "insufficient_data";
    explanation: string;
  };
  causes: Array<{
    title: string;
    confidence: number;
    evidenceCodes: string[];
    explanation: string;
  }>;
  investigationSteps: Array<{
    priority: "high" | "medium" | "low";
    action: string;
    rationale: string;
    requiredData: string[];
  }>;
  risk: {
    score: number;
    level: "low" | "medium" | "high" | "critical";
    factors: Array<{
      code: string;
      label: string;
      contribution: number;
      evidence: string;
    }>;
  };
  confidence: number;
  limitations: string[];
}
```

### Typed Evidence Codes
- `CURRENT_AFFECTED_COUNT`, `PREVIOUS_AFFECTED_COUNT`, `COUNT_CHANGE_ABSOLUTE`, `COUNT_CHANGE_PERCENT`, `TREND_INCREASING`, `TREND_DECREASING`, `TREND_STABLE`, `HISTORY_INSUFFICIENT`, `MAXIMUM_AGE_HOURS`, `AVERAGE_AGE_HOURS`, `INCIDENT_DURATION_HOURS`, `PEAK_AFFECTED_COUNT`, `NO_STAFFING_DATA`, `NO_VEHICLE_DATA`, `NO_ROUTE_CAPACITY_DATA`, `EXCEPTION_DATA_AVAILABLE`, `EXCEPTION_DATA_UNAVAILABLE`.
