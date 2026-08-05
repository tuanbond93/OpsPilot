# OpsPilot Follow-up Engine & Operational State Machine Architecture

## 1. Goal & Architectural Overview
The **Follow-up Engine** ([`src/engine/followup/`](file:///d:/Project/OpsPilot/src/engine/followup/)) provides **deterministic operational state tracking** across multi-cycle snapshot synchronizations.

### Key Governance Principles
- **100% Deterministic Rules**: State transitions, reminder delays, and escalation decisions are governed **strictly by code rules**.
- **No AI Escalation Authority**: AI Agents (such as the Root Cause Agent) provide **natural language explanations ONLY**. AI never decides whether escalation happens.
- **Configurable Cadence**: Reminder delays and improvement thresholds are configured in [`src/config/followup.ts`](file:///d:/Project/OpsPilot/src/config/followup.ts) without hardcoded time constants inside engine logic.

---

## 2. State Machine Diagram

```text
       ┌────────┐
       │  NEW   │
       └───┬────┘
           │ (Initial Push Triggered)
           ▼
  ┌─────────────────┐
  │ FIRST_PUSH_SENT │
  └────────┬────────┘
           │ (Check Progress after 2h Delay)
           ├─── Progress >= 20% ───► ┌──────────┐
           ▼                         │ RESOLVED │
    ┌──────────────┐                 └────┬─────┘
    │ FOLLOWING_UP │                      │
    └──────┬───────┘                      ▼
           │ (Check Progress after 2h) ┌────────┐
           ├─── Progress >= 20% ───► │ CLOSED │
           ▼                         └────────┘
  ┌──────────────────┐
  │ SECOND_PUSH_SENT │
  └────────┬─────────┘
           │ (Check Progress after 2h)
           ├─── Progress >= 20% ───► ┌──────────┐
           ▼                         │ RESOLVED │
     ┌───────────┐                   └──────────┘
     │ ESCALATED │ ─── Progress >= 20% ───► RESOLVED
     └───────────┘
```

---

## 3. Transition Table

| Current State | Condition / Progress Assessment | Next State | Triggered Event Type | Action / Escalation |
|---|---|---|---|---|
| `NEW` | Incident detected in snapshot | `FIRST_PUSH_SENT` | `PUSH_NOTIFICATION` | Dispatch Initial Push Notification |
| `FIRST_PUSH_SENT` | `progressAssessment == 'strong_progress'` (\(\ge 20\%\) reduction) | `RESOLVED` | `RESOLUTION` | Resolve case automatically |
| `FIRST_PUSH_SENT` | `time >= 2h` and `progress < 20%` | `FOLLOWING_UP` | `ASSESSMENT_CHECK` | Enter active follow-up monitoring |
| `FOLLOWING_UP` | `progressAssessment == 'strong_progress'` | `RESOLVED` | `RESOLUTION` | Resolve case |
| `FOLLOWING_UP` | `time >= 2h` and `progress < 20%` | `SECOND_PUSH_SENT` | `PUSH_NOTIFICATION` | Dispatch Second Push Reminder |
| `SECOND_PUSH_SENT` | `progressAssessment == 'strong_progress'` | `RESOLVED` | `RESOLUTION` | Resolve case |
| `SECOND_PUSH_SENT` | `time >= 2h` and `progress < 20%` | `ESCALATED` | `ESCALATION` | **Deterministic Escalation to Operations Lead & Manager** |
| `ESCALATED` | `progressAssessment == 'strong_progress'` or disappeared | `RESOLVED` | `RESOLUTION` | Resolve case |
| `RESOLVED` | Finalized | `CLOSED` | `CLOSURE` | Archive closed case |

---

## 4. Deterministic Assessment Rules

Progress is evaluated by comparing current affected count against previous sync count:

- **Strong Progress** (`strong_progress`): Reduction \(\ge 20\%\) (\(\text{changePercent} \le -20\%\)).
- **Limited Progress** (`limited_progress`): Reduction between \(5\%\) and \(20\%\) (\(-20\% < \text{changePercent} \le -5\%\)).
- **No Progress** (`no_progress`): Change within \(\pm 5\%\) (\(-5\% < \text{changePercent} < 5\%\)).
- **Worsening** (`worsening`): Increase \(> 5\%\) (\(\text{changePercent} \ge 5\%\)).
- **Insufficient Data** (`insufficient_data`): Fewer than 2 history points available.

---

## 5. Database Schema (`002_followup_engine.sql`)

### Table `followup_cases`
- `id` (UUID PK)
- `incident_id` (TEXT UNIQUE)
- `current_state` (VARCHAR)
- `first_detected_at` (TIMESTAMPTZ)
- `last_checked_at` (TIMESTAMPTZ)
- `current_progress_percent` (NUMERIC)
- `current_assessment` (VARCHAR)

### Table `followup_events`
- `id` (UUID PK)
- `followup_case_id` (UUID FK)
- `event_type` (VARCHAR)
- `event_time` (TIMESTAMPTZ)
- `old_state`, `new_state`, `assessment`, `notes`

---

## 6. Future Telegram Integration Note
The `FollowupMessageBuilder` produces structured JSON payloads (`StructuredFollowupPayload`). Future Telegram connectors will format and route these payloads to Telegram group chats based on state (`FIRST_PUSH_SENT` ➔ Warehouse Dispatcher Chat, `ESCALATED` ➔ Lead & Manager Group Chat).
