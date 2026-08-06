const originalEnv = process.env.NODE_ENV;
(process.env as any).NODE_ENV = 'development';

import { loadEnvConfig } from '@next/env';

console.log("Before loadEnvConfig, CWD:", process.cwd());
const result = loadEnvConfig(process.cwd(), true);
console.log("Loaded env files:", result.loadedEnvFiles);

// Restore original NODE_ENV
(process.env as any).NODE_ENV = originalEnv;

console.log("NEXT_PUBLIC_SUPABASE_URL:", process.env.NEXT_PUBLIC_SUPABASE_URL);
console.log("SUPABASE_SERVICE_ROLE_KEY is set:", !!process.env.SUPABASE_SERVICE_ROLE_KEY);
