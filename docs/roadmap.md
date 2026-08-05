# OpsPilot Development Roadmap

## Sprint 0: Architecture Design & Scaffolding (Current)
- [x] Project architecture specification (`docs/architecture.md`)
- [x] Repository folder structure creation
- [x] Base documentation (`README.md`, `coding-guidelines.md`, `roadmap.md`)
- [x] Base configuration (`package.json`, `tsconfig.json`, `tailwind.config.ts`, `.env.example`)
- [x] App Router layout & React Query provider shell setup

---

## Sprint 1: Auth & Data Layer Foundation
- [ ] Supabase schema migration setup (Users, Organizations, Fleets, Drivers, Shipments, Exceptions)
- [ ] Database Row Level Security (RLS) policies definition
- [ ] Supabase Auth implementation (Sign in, Sign up, Session Management)
- [ ] TypeScript database types generation (`database.types.ts`)

---

## Sprint 2: Core Logistics Dashboard & Operations Portal
- [ ] Operational summary dashboard layout
- [ ] Real-time shipment status list & filtering views
- [ ] Fleet tracking map view placeholder & driver assignment modal
- [ ] Incident alert feed & status update actions

---

## Sprint 3: Event Store & Operational Memory (Completed)
- [x] Database schema migrations ([`001_initial_event_store.sql`](file:///d:/Project/OpsPilot/src/database/migrations/001_initial_event_store.sql))
- [x] Supabase server-only client & repositories ([`src/connectors/supabase/`](file:///d:/Project/OpsPilot/src/connectors/supabase/))
- [x] Rillnet sync & persistence job ([`src/jobs/sync-rillnet.ts`](file:///d:/Project/OpsPilot/src/jobs/sync-rillnet.ts))
- [x] Incident model improvements & metrics calculation
- [x] Server-only debug API routes (`/api/debug/sync`, `/api/debug/sync-runs`, `/api/debug/incidents`, `/api/debug/incidents/[incidentId]/history`)
- [x] Minimal operations page ([`src/app/operations/page.tsx`](file:///d:/Project/OpsPilot/src/app/operations/page.tsx))
- [x] Vitest unit & integration test suite ([`src/__tests__/event-store.test.ts`](file:///d:/Project/OpsPilot/src/__tests__/event-store.test.ts))

---

## Sprint 4.1: AI Foundation Layer (Completed)
- [x] Provider-agnostic `AIProvider` abstraction interface (`src/ai/types.ts`)
- [x] OpenAI provider implementation (`src/ai/openai.ts`)
- [x] Gemini provider implementation (`src/ai/gemini.ts`)
- [x] Dynamic Prompt Loader `loadPrompt(name)` from `src/prompts/*.md` (`src/ai/provider.ts`)
- [x] Unit test suite with mocked providers (`src/__tests__/provider.test.ts`)

## Sprint 4.2: Root Cause Agent (Completed & Refactored)
- [x] Evidence-grounded pipeline (`context-builder.ts`, `evidence-builder.ts`, `risk-calculator.ts`, `schema.ts`, `agent.ts`)
- [x] Deterministic trend & progress calculation rules (`strong_progress`, `limited_progress`, `no_material_progress`, `worsening`, `insufficient_data`)
- [x] Deterministic risk engine & factor breakdown (capped at 100)
- [x] Typed `evidenceCodes` and anti-hallucination verification
- [x] Externalized prompt metadata (`--- name: rootcause version: 2 language: vi ---`)
- [x] Debug endpoint `GET /api/debug/rootcause/[incidentId]`
- [x] Interactive `/rootcause` playground page separating Verified Evidence from AI Explanation
- [x] 20 unit tests in `src/__tests__/rootcause.test.ts` (0 external API calls)

## Sprint 4.3: Follow-up Engine & Operational State Machine (Completed)
- [x] Database migration `002_followup_engine.sql` (`followup_cases` & `followup_events`)
- [x] Configurable follow-up policy (`src/config/followup.ts`)
- [x] Deterministic State Machine (`NEW` ➔ `FIRST_PUSH_SENT` ➔ `FOLLOWING_UP` ➔ `SECOND_PUSH_SENT` ➔ `ESCALATED` ➔ `RESOLVED` ➔ `CLOSED`)
- [x] Deterministic Progress Assessment (`strong_progress`, `limited_progress`, `no_progress`, `worsening`, `insufficient_data`)
- [x] `FollowupMessageBuilder` structured payload builder
- [x] Debug endpoints `GET /api/debug/followups` & `GET /api/debug/followups/[id]`
- [x] Interactive `/followups` dashboard page (DB read-only)
- [x] Test suite in `src/__tests__/followup.test.ts`
- [x] Documentation in `docs/followup-engine.md`

## Sprint 4.4 - 4.5: Next AI & Alert Agents (Upcoming)
- [ ] Sprint 4.4: Message Agent & Telegram Connector (`src/agents/message/`)
- [ ] Sprint 4.5: Summary Agent & Optimization Agent (`src/agents/summary/`)

---

## Sprint 5: Hardening, Performance & Launch
- [ ] End-to-End testing & security audit
- [ ] Production build optimization & bundle analysis
- [ ] CI/CD deployment pipeline configuration (Vercel / Supabase)
