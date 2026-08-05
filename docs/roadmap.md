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

## Sprint 4: Realtime Telematics & Automated Alerts
- [ ] Supabase Realtime subscriptions for shipment location & delay events
- [ ] Automated push alert dispatch system
- [ ] Operational metrics analytics page

---

## Sprint 5: Hardening, Performance & Launch
- [ ] End-to-End testing & security audit
- [ ] Production build optimization & bundle analysis
- [ ] CI/CD deployment pipeline configuration (Vercel / Supabase)
