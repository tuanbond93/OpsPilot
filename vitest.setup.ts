const originalEnv = process.env.NODE_ENV;
(process.env as any).NODE_ENV = 'development';

import { loadEnvConfig } from '@next/env';
import { installRillnetFetchFixture } from './src/__tests__/fixtures/rillnet-fetch';

const result = loadEnvConfig(process.cwd(), true);
console.log("[test-env] loaded env files:", result.loadedEnvFiles.map((file) => file.path));

// Restore original NODE_ENV
(process.env as any).NODE_ENV = originalEnv;
process.env.ALLOW_IN_MEMORY_FALLBACK = "true";
installRillnetFetchFixture();

console.log("[test-env] Supabase URL configured:", Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL));
console.log("[test-env] service role configured:", Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY));
