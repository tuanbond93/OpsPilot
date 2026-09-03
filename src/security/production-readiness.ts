export type ProductionReadinessCheck = {
  key: "auth_enforcement" | "supabase_url" | "supabase_anon_key" | "supabase_service_role" | "cron_secret";
  ready: boolean;
};

/**
 * Reports only configuration presence. It never returns secret values and does
 * not attempt a network call, so it is safe for a protected system status API.
 */
export function assessProductionReadiness(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === "production";
  const checks: ProductionReadinessCheck[] = [
    { key: "auth_enforcement", ready: env.AUTH_ENFORCEMENT_ENABLED === "true" },
    { key: "supabase_url", ready: Boolean(env.NEXT_PUBLIC_SUPABASE_URL) },
    { key: "supabase_anon_key", ready: Boolean(env.NEXT_PUBLIC_SUPABASE_ANON_KEY) },
    { key: "supabase_service_role", ready: Boolean(env.SUPABASE_SERVICE_ROLE_KEY) },
    { key: "cron_secret", ready: Boolean(env.CRON_SECRET) },
  ];

  return {
    production,
    ready: !production || checks.every((check) => check.ready),
    checks,
  };
}
