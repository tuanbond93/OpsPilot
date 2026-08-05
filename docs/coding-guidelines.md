# OpsPilot Engineering & Coding Guidelines

## 1. General Principles

- **Simplicity First**: Write readable, self-documenting code. Avoid premature abstractions.
- **Type Safety**: Strictly typed TypeScript codebase. Do not use `any` or loose type casting unless explicitly justified.
- **Component Isolation**: Keep components focused on a single responsibility.

---

## 2. Directory & Naming Conventions

### 2.1 File & Directory Names
- Use **kebab-case** for file and directory names (e.g., `shipment-card.tsx`, `query-provider.tsx`, `use-fleet-status.ts`).
- Route directories in `src/app` follow standard Next.js conventions (e.g., `(dashboard)/shipments/page.tsx`).

### 2.2 Component & Type Names
- Use **PascalCase** for React components, interfaces, types, and enums (e.g., `ShipmentCard`, `ShipmentStatus`, `UserRole`).
- Use **camelCase** for function names, variables, hooks, and utility methods (e.g., `useShipmentDetails`, `formatCurrency`).

---

## 3. Next.js & React Guidelines

### 3.1 Server Components vs Client Components
- Default to **Server Components** for pages, layouts, and data fetchers.
- Add `"use client"` **only** at the top of components that require state (`useState`, `useReducer`), effects (`useEffect`), browser APIs, or interactive event listeners (`onClick`, `onChange`).
- Keep Client Components at the leaves of your component tree.

### 3.2 Data Fetching & Caching
- Initial page data fetching should be performed in Server Components using Supabase server client.
- Dynamic, client-initiated, or real-time data fetching must be wrapped in custom React Query hooks inside `src/hooks/` or `src/services/`.

---

## 4. Supabase Integration Rules

1. Never instantiate Supabase clients directly inside component bodies. Always use helper factories from `@/lib/supabase/client` or `@/lib/supabase/server`.
2. Do not expose `SUPABASE_SERVICE_ROLE_KEY` to browser client bundles. All administrative operations using service role key must run exclusively inside Server Actions or API Route Handlers.
3. Database types should be synced with Supabase CLI schemas into `@/types/database.types.ts`.

---

## 5. Styling Guidelines

1. Use Tailwind CSS classes for styling. Avoid inline styles (`style={{ ... }}`).
2. Merge dynamic Tailwind class names using the `cn()` utility from `@/lib/utils`.
3. Follow color palette semantics:
   - Primary Actions: `bg-blue-600 hover:bg-blue-700`
   - Backgrounds: `bg-slate-950` (app background), `bg-slate-900` (cards/modals)
   - Borders: `border-slate-800`
