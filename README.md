# OpsPilot - AI Operations Engine for Logistics

OpsPilot is an enterprise AI Operations Engine designed for logistics order management, backlog control, SLA breach tracking, automated escalation, and multi-channel notifications (Telegram / Web Control Room).

---

## 💡 Core Design Principles

1. **Rillnet Operations Snapshot Source**: Rillnet serves as the primary operational snapshot provider.
2. **Rule-First Architecture (MVP)**: Clear, deterministic issues (e.g. "stuck in warehouse", "unassigned driver", "customer rescheduled") are processed directly by the **Rule Engine** without calling AI. AI Agents are invoked **only** when data is ambiguous or requires natural language synthesis.
3. **Scheduler & Rule Engine Governance**: Follow-up cadence (e.g., 08:00 → 10:00 → 12:00) is governed strictly by the **Rule Engine + Scheduler**. AI Agents never decide timing; they only draft content and analyze context when triggered.

---

## 📁 Repository Structure

```text
src/
├── app/                  # Next.js App Router (pages, layouts, routes)
├── components/           # UI & Feature components
│   ├── ui/               # Atomic UI components
│   ├── common/           # Navigation & headers
│   └── features/         # Feature domains (orders, backlog, sla, incidents, push, reports)
├── connectors/           # Integration Layer
│   ├── rillnet/          # Rillnet Operations Snapshot Source connector
│   ├── ghn/              # GHN shipping carrier connector
│   ├── telegram/         # Telegram bot integration
│   ├── google/           # Google Sheets integration
│   └── supabase/         # Supabase client connector
├── engine/               # Operations Engine ("The Brain")
│   ├── incident/         # Incident detection engine
│   ├── priority/         # Urgency priority calculator
│   ├── scheduler/        # Task scheduler
│   └── rules/            # Configurable rules (push.ts, sla.ts, exception.ts, priority.ts)
├── ai/                   # Provider-Agnostic AI Foundation Layer
│   ├── types.ts          # Common interfaces (AIProvider, AIResponse, GenerateOptions)
│   ├── openai.ts         # OpenAI provider implementation (gpt-4o-mini)
│   ├── gemini.ts         # Google Gemini provider implementation (gemini-1.5-flash)
│   ├── provider.ts       # Provider factory, switcher & loadPrompt() loader
│   └── index.ts          # Module re-exports
├── agents/               # Autonomous AI Agents (Call AIProvider only)
│   ├── root-cause/       # Root cause analysis agent
│   ├── message/          # Automated message drafting agent
│   ├── followup/         # Followup text generation agent
│   ├── summary/          # Shift summary reporting agent
│   └── optimization/     # Process optimization agent
├── jobs/                 # Background & Scheduled Tasks
│   ├── sync-rillnet.ts   # Sync from Rillnet Operations Snapshot Source
│   ├── check-sla.ts      # Check order ages against SLA rules
│   ├── followup.ts       # Execute rule-driven followup schedules
│   └── telegram.ts       # Dispatch pending notifications
├── prompts/              # System Prompts for AI Agents (.md files)
├── config/               # Operational Configuration (warehouses, customers, sla, constants)
├── database/             # Database Schemas, Migrations & Seeds
├── hooks/                # Custom React Hooks
├── providers/            # React Context Providers (QueryProvider)
├── types/                # TypeScript Interfaces & Types
└── lib/                  # Utilities & Helpers
```

---

## 🚀 Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Run TypeScript type check
npx tsc --noEmit

# 3. Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the application.
