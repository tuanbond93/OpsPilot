# OpsPilot Architecture Specification (Refined)

## 1. Executive Summary

**OpsPilot** is an automated, event-driven AI Operations Engine engineered for logistics order management, backlog control, SLA breach tracking, automated escalation dispatching, and targeted AI-assisted analysis.

---

## 2. Core Architecture & Clarifications

### 2.1 Rillnet Integration
- **Classification**: **Rillnet Operations Snapshot Source**.
- **Role**: Rillnet serves as the primary operational snapshot data provider (orders, warehouse status, dispatch states). It is consumed via the Rillnet Connector ([`src/connectors/rillnet/`](file:///d:/Project/OpsPilot/src/connectors/rillnet/)).

#### Rillnet Connector Data Flow
```text
┌─────────────────────────────────────────────────────────────┐
│ 1. Request Signed URL                                       │
│    POST https://rillnet-app.vercel.app/api/gtalk-send       │
│    Body: { "op": "opssnap" }                                │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Download GZIP Buffer                                     │
│    GET signedUrl (from snap.liveUrl || snap.url)            │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Decompress & Validate JSON                               │
│    zlib / DecompressionStream -> parse RawRillnetOrder[]   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Map to Normalized Order                                  │
│    mapRawOrderToNormalized -> NormalizedRillnetOrder Model  │
└─────────────────────────────────────────────────────────────┘
```

- **Module Breakdown**:
  - [`client.ts`](file:///d:/Project/OpsPilot/src/connectors/rillnet/client.ts): Handles HTTP request for signed URL and GZIP buffer download.
  - [`snapshot.ts`](file:///d:/Project/OpsPilot/src/connectors/rillnet/snapshot.ts): Decompresses GZIP binary buffer using Node `zlib` or Web `DecompressionStream`.
  - [`parser.ts`](file:///d:/Project/OpsPilot/src/connectors/rillnet/parser.ts): Validates raw JSON format and root array structure.
  - [`mapper.ts`](file:///d:/Project/OpsPilot/src/connectors/rillnet/mapper.ts): Maps raw fields (`order_code`, `status`, `client_id`, `current_warehouse_id`) to OpsPilot normalized order models.
  - [`types.ts`](file:///d:/Project/OpsPilot/src/connectors/rillnet/types.ts): Defines custom error classes (`RillnetRequestError`, `RillnetInvalidUrlError`, `RillnetDownloadError`, `RillnetDecompressError`, `RillnetParseError`), raw source types, and normalized models.


### 2.2 Decision Priority: Deterministic Rules vs. AI Agents (Rule-First MVP Strategy)
In MVP, AI is **not** placed in front of every incident. Deterministic operations are handled strictly by the **Rule Engine**:

```
                              [ Incident Event ]
                                       │
                                       ▼
                         ┌───────────────────────────┐
                         │   Rule Engine Inspection  │
                         └─────────────┬─────────────┘
                                       │
                ┌──────────────────────┴──────────────────────┐
                │ Clear Rule Match                           │ Ambiguous Data /
                │ (stuck in warehouse, unassigned,           │ Unstructured Communication
                │  customer reschedule)                      │ Required
                ▼                                            ▼
┌───────────────────────────────┐            ┌───────────────────────────────┐
│ Direct Action / Auto-Tagging  │            │ Trigger AI Agent              │
│ (Handled by Rule Engine)      │            │ (Root-Cause / Message Agent)  │
└───────────────────────────────┘            └───────────────────────────────┘
```

- **Rule Engine (Primary)**: Handles deterministic cases directly (e.g. "Stuck in warehouse", "Unassigned driver", "Customer rescheduled"). Zero AI latency / zero LLM token cost for known operational rules.
- **AI Agent (Fallback / Specialist)**: Invoked **only** when data is ambiguous, unstructured, or requires natural language summary synthesis and draft composition.

### 2.3 Follow-up Scheduling Governance
- Follow-up escalation timelines (e.g., 08:00 → 10:00 → 12:00) are **strictly controlled by Rule Engine + Scheduler**.
- **AI Agents do NOT decide execution schedules**. Agents are invoked by the Rule Engine at scheduled trigger times solely to generate message content, analyze root causes, or format summaries.

---

## 3. Event Pipeline Architecture

```text
Rillnet Operations Snapshot Source
       ↓
Connector Layer (src/connectors/rillnet/)
       ↓
Rule Engine (src/engine/rules/: push.ts, sla.ts, priority.ts)
       ├───► [Known Rules: Auto-Tag / Direct Dispatch]
       └───► [Ambiguous / Unstructured Data] ──► AI Agent (src/agents/)
                                                         │
       ┌─────────────────────────────────────────────────┘
       ▼
Telegram / Push Alert (Dispatched by Rule Engine + Scheduler)
       ↓
Ops Control Room Dashboard
```

---

## 4. Operational Modules & Responsibilities

### 4.1 Connectors (`src/connectors/`)
- `rillnet/`: Connector for Rillnet Operations Snapshot Source.
- `ghn/`: Shipping carrier integration.
- `telegram/`: Telegram bot channel connector.
- `google/`: Google Sheets integration for ops reporting.
- `supabase/`: Database and Auth state connector.

### 4.2 Engine ("The Brain") (`src/engine/`)
- `rule-engine`: Primary decision maker for SLA thresholds, auto-tagging, and escalation timers (`08:00 → 10:00 → 12:00`).
- `incident-engine`: Detects backlog bottlenecks and SLA risks.
- `priority-engine`: Computes urgency priority rankings.
- `scheduler`: Triggers rule checks on fixed schedules.

### 4.3 AI Agents Layer & AI Foundation (`src/ai/` & `src/agents/`)
OpsPilot features a **Provider-Agnostic AI Foundation Layer** ([`src/ai/`](file:///d:/Project/OpsPilot/src/ai/)):

```text
┌─────────────────────────────────────────────────────────────┐
│                       AI Agent Layer                        │
│ (src/agents/: root-cause, summary, message, optimization)   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Provider-Agnostic AI Layer                  │
│                     (src/ai/provider.ts)                    │
│   - loadPrompt(name) -> loads templates from src/prompts/   │
│   - getAIProvider()  -> resolves active LLM provider       │
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
               ▼                              ▼
┌──────────────────────────────┐┌──────────────────────────────┐
│  OpenAI Provider             ││  Gemini Provider             │
│  (src/ai/openai.ts)          ││  (src/ai/gemini.ts)          │
│  gpt-4o-mini / gpt-4o        ││  gemini-1.5-flash            │
└──────────────────────────────┘└──────────────────────────────┘
```

- **Clean Architecture Principle**: Agents NEVER call OpenAI or Gemini APIs directly. All interactions use the `AIProvider` abstraction interface (`generate()`).
- **Prompt Loader**: Prompts are stored as raw markdown files in `src/prompts/` and loaded dynamically via `loadPrompt(name)`.
- **Extensibility**: Custom providers (e.g. Anthropic Claude, OpenRouter, Local Ollama) can be added by implementing `AIProvider` and calling `registerAIProvider(provider)`.
