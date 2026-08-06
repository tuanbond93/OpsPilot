# OpsPilot Action Planner Architecture & Technical Specification (Sprint 6 Phase 1 Design)

## 1. Executive Summary & Purpose

The **Action Planner** is an AI-assisted operational decision recommendation engine for OpsPilot. It synthesizes multi-source operational context—including persisted Event Store incident metrics, Root Cause Agent findings, Follow-up Engine tracking history, and Notification Action Queue execution logs—to produce structured, evidence-grounded operational recommendations and investigation playbooks for logistics leaders, warehouse managers, and operational dispatchers.

```text
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                 OpsPilot Event Store                                    │
│  (sync_runs, order_snapshots, incidents, incident_history, order_exceptions)           │
└──────────────────────────────────────────┬──────────────────────────────────────────────┘
                                           │
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           Operational State & Analysis Modules                          │
│   ┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────────────┐   │
│   │   Incident Engine   │   │  Root Cause Agent   │   │       Follow-up Engine      │   │
│   │ (Priority & Trend)  │   │(Evidence & Diagnosis│   │ (State Machine & Progress)  │   │
│   └──────────┬──────────┘   └──────────┬──────────┘   └──────────────┬──────────────┘   │
└──────────────┼─────────────────────────┼─────────────────────────────┼──────────────────┘
               │                         │                             │
               └─────────────────────────┼─────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                 PlannerContextBuilder                                   │
│            (Aggregates Evidence, Formats History, Computes Data Gaps)                  │
└──────────────────────────────────────────┬──────────────────────────────────────────────┘
                                           │
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    Action Planner                                       │
│          (Prompt: planner.md ──► AIProvider ──► Schema Parsing & Fallbacks)             │
└──────────────────────────────────────────┬──────────────────────────────────────────────┘
                                           │
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                 PlannerResult Schema                                    │
│  (Recommendations, Investigation Steps, Confidence Score, Limitations, Next Review)     │
└──────────────────────────────────────────┬──────────────────────────────────────────────┘
                                           │
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           Action Queue / Human Operator Review                          │
│            (Deterministic Rule Engine or Manual Confirmation before Execution)          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Responsibilities & Non-Responsibilities

### 2.1 Core Responsibilities
1. **Multi-Source Context Synthesis**: Combine data from Incident Engine (metrics, priority), Root Cause Agent (diagnosis, evidence codes), Follow-up Engine (state machine stage, progress assessment), and Action Queue (previous notifications sent, delivery outcomes).
2. **Prioritized Action Recommendations**: Generate actionable, role-targeted operational recommendations (e.g. shift re-allocation, exception verification, carrier SLA notification) with rationale and risk/impact scores.
3. **Structured Investigation Paths**: Provide step-by-step investigation procedures when data is missing or operational ambiguity exists.
4. **Data Gap & Limitation Disclosure**: Explicitly state system boundaries (e.g., absence of real-time WMS staffing rosters, driver GPS, or weather feeds).
5. **Hybrid Confidence Computation**: Calculate a transparent confidence score combining deterministic data completeness metrics and AI synthesis confidence.
6. **Deterministic Next Review Model**: Calculate the recommended time interval until the next operational evaluation based on incident risk level and state progression.

### 2.2 Non-Responsibilities & Strict Constraints
- **NO Autonomous Action Dispatch**: The Action Planner **MUST NEVER** directly dispatch messages to messaging channels (Telegram, Zalo, Email) or write `SENT` actions. Action execution remains governed by the Action Queue and deterministic state machine rules.
- **NO Direct Provider / SDK Imports**: The planner **MUST NEVER** import `openai` or `@google/generative-ai` directly. All AI invocations must use the system-wide `AIProvider` abstraction ([`src/ai/provider.ts`](file:///d:/Project/OpsPilot/src/ai/provider.ts)).
- **NO Direct External API Calls**: The planner **MUST NEVER** call external connectors (Rillnet, WMS, ERP) directly. It operates exclusively on persisted Supabase Event Store data.
- **NO Fabricated Operational Facts**: The planner **MUST NOT** invent unverified operational facts (e.g., specific driver names, vehicle plate numbers, weather forecasts, or exact staffing headcounts).
- **NO Unsubstantiated Outcome Promises**: The planner **MUST NOT** promise arbitrary quantitative operational outcomes (e.g. "Backlog will drop by 45% in 2 hours").

---

## 3. Input & Output Interface Specifications

### 3.1 Input Interface (`PlannerInput`)

```typescript
export interface PlannerInput {
  /** Target incident record */
  incident: Incident;
  
  /** Historical snapshots for trend analysis */
  historyRows: IncidentHistoryRow[];
  
  /** Root cause analysis output (if available) */
  rootCauseResult?: RootCauseResult | null;
  
  /** Follow-up case record (if available) */
  followupCase?: FollowupCaseRow | null;
  
  /** Follow-up events timeline */
  followupEvents?: FollowupEventRow[];
  
  /** Recent notification actions dispatched for this incident */
  actionHistory?: NotificationActionRow[];
  
  /** Active order exceptions for affected orders */
  activeExceptions?: OrderExceptionRow[];
  
  /** Optional execution options */
  options?: {
    provider?: string;
    model?: string;
    temperature?: number;
  };
}
```

### 3.2 Output Interface (`PlannerResult`)

```typescript
export interface PlannerRecommendation {
  id: string;
  type: "OPERATIONAL_ADJUSTMENT" | "EXCEPTION_VERIFICATION" | "CARRIER_COMMUNICATION" | "STAFFING_REVIEW" | "ESCALATION_PREPARATION";
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  targetRole: "WAREHOUSE_DISPATCHER" | "OPERATIONS_LEAD" | "WAREHOUSE_MANAGER" | "LOGISTICS_EXECUTIVE";
  rationale: string;
  evidenceCodes: string[];
  riskImpact: {
    severity: "low" | "medium" | "high" | "critical";
    potentialConsequence: string;
  };
  prerequisiteData: string[];
  estimatedTimeframeMinutes: number;
}

export interface PlannerInvestigation {
  id: string;
  priority: "high" | "medium" | "low";
  action: string;
  rationale: string;
  targetDepartment: "WAREHOUSE_OPS" | "TRANSPORT_LOGISTICS" | "CUSTOMER_SERVICE" | "IT_SYSTEMS";
  requiredData: string[];
  safetyCheck: string;
}

export interface NextReviewModel {
  recommendedIntervalMinutes: number;
  nextReviewTimeIso: string;
  triggerCondition: string;
}

export interface PlannerResult {
  summary: string;
  
  operationalStatus: {
    stage: string;
    riskLevel: "low" | "medium" | "high" | "critical";
    trendAssessment: "improving" | "stagnant" | "worsening" | "insufficient_data";
    explanation: string;
  };

  recommendations: PlannerRecommendation[];
  
  investigationSteps: PlannerInvestigation[];
  
  nextReview: NextReviewModel;
  
  confidence: {
    score: number; // 0 - 100
    level: "high" | "medium" | "low";
    factors: Array<{
      factor: string;
      weight: number;
      score: number;
      explanation: string;
    }>;
  };

  limitations: string[];
}
```

---

## 4. Planner Workflow & Component Architecture

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. Data Retrieval Phase                                                                │
│    Fetch Incident + History + RootCauseResult + FollowupCase + ActionQueue Logs        │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 2. Context Building Phase (PlannerContextBuilder)                                      │
│    - Compute Trend & SLA Breach Probability                                            │
│    - Extract Evidence Codes & Deterministic Risk Score                                 │
│    - Identify Missing Data Vectors (Staffing, GPS, Weather)                             │
│    - Format History & Timeline into Structured Prompt Input Payload                   │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 3. Prompt Execution Phase                                                              │
│    - Load system prompt from src/prompts/planner.md                                    │
│    - Inject sanitized context payload into {{plannerContext}}                          │
│    - Call AIProvider.generate(promptText, inputPayload, options)                       │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 4. Validation & Sanitization Phase                                                     │
│    - Parse JSON response with parsePlannerResult()                                     │
│    - Validate evidence code references against allowedEvidenceCodes                     │
│    - Compute hybrid confidence score                                                   │
│    - Enforce deterministic Next Review Model interval                                  │
│    - On JSON parse or AI error ──► Return createFallbackPlannerResult()                │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 5. Action Recommendation Exposure Phase                                                │
│    - Expose PlannerResult to UI Dashboard                                              │
│    - Optionally propose candidate Notification Actions to Action Queue                 │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Context Builder Design (`PlannerContextBuilder`)

The `PlannerContextBuilder` is a deterministic TypeScript utility responsible for transforming raw database records into a clean, normalized context object for AI synthesis.

### 5.1 Context Data Structure (`PlannerContext`)

```typescript
export interface PlannerContext {
  incident: {
    key: string;
    warehouseId: string;
    warehouseName: string;
    reasonCode: string;
    reasonName: string;
    status: string;
    priorityScore: number;
    firstDetectedAt: string;
    lastDetectedAt: string;
    durationHours: number;
  };
  
  metrics: {
    currentAffectedOrderCount: number;
    previousAffectedOrderCount: number;
    peakAffectedOrderCount: number;
    averageAgeHours: number;
    maximumAgeHours: number;
    countChangePercent: number;
    progressAssessment: "strong_progress" | "limited_progress" | "no_progress" | "worsening" | "insufficient_data";
  };

  rootCauseSummary?: {
    status: string;
    primaryCauses: Array<{ title: string; confidence: number; evidenceCodes: string[] }>;
    riskScore: number;
    riskLevel: string;
  };

  followupSummary?: {
    currentState: string;
    lastActionConfirmedAt?: string | null;
    confirmedBy?: string | null;
    totalPushesSent: number;
  };

  actionHistorySummary: Array<{
    actionType: string;
    provider: string;
    status: string;
    outcome?: string | null;
    processedAt?: string | null;
  }>;

  exceptionSummary: {
    activeExceptionCount: number;
    reasonsPresent: string[];
  };

  allowedEvidenceCodes: string[];
  identifiedDataGaps: string[];
}
```

### 5.2 Context Building Logic & Rules
1. **Duration Calculation**: \(\text{durationHours} = \frac{\text{lastDetectedAt} - \text{firstDetectedAt}}{3600000}\)
2. **Trend Evaluation**: Compare latest `affected_order_count` against `incident_history` snapshots to compute `countChangePercent` and `progressAssessment`.
3. **Evidence Code Assembly**: Combine evidence codes from `RootCauseAgent` + metrics-derived evidence codes (`CURRENT_AFFECTED_COUNT`, `MAXIMUM_AGE_HOURS`, `TREND_WORSENING`, `HAS_ACTIVE_EXCEPTIONS`).
4. **Data Gap Identification**: Check for missing vectors and populate `identifiedDataGaps[]`:
   - `NO_STAFFING_DATA`: Staffing roster data unavailable in system.
   - `NO_VEHICLE_GPS_DATA`: Vehicle location tracking unavailable.
   - `NO_EXTERNAL_CARRIER_API`: External carrier API integration absent.

---

## 6. Prompt Design Specification (`src/prompts/planner.md`)

```markdown
---
name: planner
version: 1
language: vi
---

# System Prompt: OpsPilot Action Planner Agent

You are the Senior Logistics Operations Strategist for OpsPilot. Your responsibility is to analyze operational incident context, root cause diagnostic evidence, follow-up tracking status, and action history, then generate actionable, prioritized operational recommendations and investigation procedures in clear Vietnamese.

## STRICT HALLUCINATION GUARD & NON-GOAL CONSTRAINTS
1. **ONLY** use evidence statements and evidenceCodes provided in `allowedEvidenceCodes` and `plannerContext`.
2. **DO NOT** invent driver names, vehicle plate numbers, staffing rosters, route capacities, weather forecasts, or customer details.
3. **DO NOT** promise arbitrary quantitative operational outcomes (e.g. DO NOT say "Tồn đọng sẽ giảm 50% sau 2 giờ").
4. **DO NOT** execute actions directly or issue binding operational orders. Phrase recommendations as advice for role targets (e.g. "Đề xuất Trưởng ca kho kiểm tra...").
5. Every recommendation in `recommendations` MUST reference valid `evidenceCodes` from `allowedEvidenceCodes`.
6. If data is missing (e.g. no staffing data, no vehicle data), state the limitation explicitly in `limitations` and `investigationSteps`.
7. Suggest ONLY safe, non-disruptive investigation steps.

## REQUIRED OUTPUT JSON SCHEMA
```json
{
  "summary": "Tóm tắt 2-3 câu về tình hình vận hành hiện tại và định hướng xử lý.",
  "operationalStatus": {
    "stage": "FIRST_PUSH_SENT | FOLLOWING_UP | ESCALATED | RESOLVED",
    "riskLevel": "low | medium | high | critical",
    "trendAssessment": "improving | stagnant | worsening | insufficient_data",
    "explanation": "Giải thích trạng thái và xu hướng dựa trên dữ liệu lịch sử."
  },
  "recommendations": [
    {
      "id": "rec-1",
      "type": "OPERATIONAL_ADJUSTMENT | EXCEPTION_VERIFICATION | CARRIER_COMMUNICATION | STAFFING_REVIEW | ESCALATION_PREPARATION",
      "title": "Tiêu đề đề xuất hành động",
      "description": "Mô tả chi tiết hành động cần thực hiện",
      "priority": "high | medium | low",
      "targetRole": "WAREHOUSE_DISPATCHER | OPERATIONS_LEAD | WAREHOUSE_MANAGER | LOGISTICS_EXECUTIVE",
      "rationale": "Lý do đề xuất dựa trên bằng chứng",
      "evidenceCodes": ["CURRENT_AFFECTED_COUNT", "MAXIMUM_AGE_HOURS"],
      "riskImpact": {
        "severity": "low | medium | high | critical",
        "potentialConsequence": "Hậu quả nếu không thực hiện hành động này"
      },
      "prerequisiteData": ["Danh sách mã đơn tồn đọng >48h"],
      "estimatedTimeframeMinutes": 30
    }
  ],
  "investigationSteps": [
    {
      "id": "inv-1",
      "priority": "high | medium | low",
      "action": "Bước rà soát kiểm tra an toàn",
      "rationale": "Lý do rà soát dựa trên điểm nghẽn bằng chứng",
      "targetDepartment": "WAREHOUSE_OPS | TRANSPORT_LOGISTICS | CUSTOMER_SERVICE | IT_SYSTEMS",
      "requiredData": ["Báo cáo ca trực", "Mã đơn hàng"],
      "safetyCheck": "Yêu cầu xác nhận trước khi thay đổi quy trình"
    }
  ],
  "limitations": [
    "Hệ thống chưa kết nối dữ liệu ca trực và nhân sự kho real-time.",
    "Chưa có dữ liệu vị trí GPS của phương tiện vận tải."
  ]
}
```
```

---

## 7. Confidence Model & Next Review Model

### 7.1 Hybrid Confidence Model Formula

The Action Planner confidence score (\(S_{\text{conf}} \in [0, 100]\)) is computed using a hybrid formula combining deterministic data completeness metrics and AI synthesis confidence:

\[
S_{\text{conf}} = \max\left(0, \min\left(100, \, w_1 \cdot C_{\text{data}} + w_2 \cdot C_{\text{rootcause}} + w_3 \cdot C_{\text{history}} - P_{\text{gaps}}\right)\right)
\]

Where:
- **\(C_{\text{data}}\)**: Data Completeness Score (0–100). Points awarded for presence of incident history (\(+30\)), root cause result (\(+30\)), follow-up case (\(+20\)), action history (\(+10\)), order exceptions (\(+10\)). Weight \(w_1 = 0.40\).
- **\(C_{\text{rootcause}}\)**: Root Cause Agent Confidence Score (0–100). Weight \(w_2 = 0.30\).
- **\(C_{\text{history}}\)**: History Depth Score. Based on number of `incident_history` snapshots (\(\ge 5\) snapshots \(\rightarrow 100\), 3–4 snapshots \(\rightarrow 70\), 1–2 snapshots \(\rightarrow 40\), 0 snapshots \(\rightarrow 0\)). Weight \(w_3 = 0.30\).
- **\(P_{\text{gaps}}\)**: Data Gap Penalty. \(-10\) points for each identified data gap (e.g. `NO_STAFFING_DATA`, `NO_VEHICLE_GPS_DATA`).

#### Confidence Level Classification:
- **`high`**: \(S_{\text{conf}} \ge 80\)
- **`medium`**: \(50 \le S_{\text{conf}} < 80\)
- **`low`**: \(S_{\text{conf}} < 50\)

---

### 7.2 Deterministic Next Review Model Formula

The Next Review interval (\(T_{\text{review}}\) in minutes) dictates when the Action Planner should re-evaluate the incident. It is governed **100% deterministically** based on Risk Level and Progress Trend:

| Risk Level | Trend Assessment | Base Review Interval (\(T_{\text{base}}\)) | Trigger Condition |
|---|---|---|---|
| `critical` | `worsening` / `stagnant` | **15 minutes** | Immediate re-check on next snapshot |
| `critical` | `improving` | **30 minutes** | Re-evaluate if progress slows |
| `high` | `worsening` / `stagnant` | **30 minutes** | Scheduled follow-up check |
| `high` | `improving` | **60 minutes** | Check at next hourly sync |
| `medium` | Any | **120 minutes (2 hours)** | Standard follow-up cycle |
| `low` | Any | **240 minutes (4 hours)** | Routine monitoring |

\[
\text{nextReviewTimeIso} = \text{referenceTime} + T_{\text{base}} \times 60 \times 1000
\]

---

## 8. Integration Specifications

### 8.1 Integration with Incident Engine
- **Data Contract**: Ingests `Incident` row and `IncidentHistoryRow[]`.
- **Interaction**: Incident Engine triggers Action Planner evaluation when `priority_score` exceeds configured threshold (\(\ge 50\)) or state changes.

### 8.2 Integration with Root Cause Agent
- **Data Contract**: Ingests `RootCauseResult`.
- **Interaction**: Action Planner uses `causes[]`, `evidenceCodes[]`, and `risk.factors[]` as key inputs to generate targeted recommendations that address specific root causes.

### 8.3 Integration with Follow-up Engine
- **Data Contract**: Ingests `FollowupCaseRow` and `FollowupEventRow[]`.
- **Interaction**: Planner checks `current_state` (e.g. `FIRST_PUSH_SENT`, `SECOND_PUSH_PENDING`, `ESCALATED`) to align recommendation priorities with the current stage of the state machine.

### 8.4 Integration with Action Queue
- **Data Contract**: Ingests `NotificationActionRow[]` execution history; produces candidate action parameters.
- **Interaction**: Planner recommendations can propose candidate notification actions (e.g. `SECOND_PUSH`, `ESCALATION`) to the Action Queue. **Execution requires deterministic rule engine or manual operator approval**.

---

## 9. Acceptance Criteria (Phase 2 Readiness)

1. **Schema Integrity**: `PlannerResult` TypeScript interface and `planner.md` prompt schema match 1:1.
2. **Strict Hallucination Prevention**: 100% of recommendation `evidenceCodes` are validated against `allowedEvidenceCodes`. Invalid codes are filtered automatically.
3. **No Direct Provider Dependencies**: Agent uses `AIProvider.generate()` exclusively.
4. **Deterministic Fallback Guarantee**: If AI API fails or returns malformed JSON, `createFallbackPlannerResult()` returns a valid `PlannerResult` object populated with deterministic metrics.
5. **Confidence & Next Review Determinism**: Confidence scores and Next Review intervals strictly follow mathematical formulas without AI drift.
6. **Zero Code Implementation in Phase 1**: Specification and design documentation deliverable only (`docs/action-planner.md`). No implementation code or API routes added in Phase 1.
