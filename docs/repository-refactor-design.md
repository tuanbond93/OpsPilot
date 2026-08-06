# Repository Layer Design Document

The Repository Layer abstracts data persistence behind interface contracts.

## Key Design Patterns

1. **Interface Contracts (`src/repositories/interfaces/*`)**
   - Clean TypeScript interfaces defining CRUD and query methods.
   - Re-exports database Row DTO types so higher layers do not import connector types.

2. **Repository Factory (`src/repositories/RepositoryFactory.ts`)**
   - Resolves appropriate repository implementations (`Supabase*Repository` or `Mock*Repository`) based on client presence and fallback policy (`isFallbackAllowed()`).
   - Supports explicit `register*Repository()` setter methods for unit test dependency injection.

3. **Concrete Supabase Repositories (`src/repositories/supabase/*`)**
   - Implements interface contracts using direct Supabase client queries.
   - Encapsulates database schema details and RPC calls.
