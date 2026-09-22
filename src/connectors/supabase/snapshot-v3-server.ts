import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  isSnapshotV3ShadowEnabled,
  SNAPSHOT_V3_SUPABASE_SERVICE_ROLE_KEY_ENV,
  SNAPSHOT_V3_SUPABASE_URL_ENV,
} from "@/config/snapshot-v3";

let shadowClient: SupabaseClient | null = null;

/**
 * Creates the V3 shadow client lazily and only from dedicated server-side
 * credentials. The primary Supabase client is intentionally not accepted.
 */
export function createSnapshotV3ShadowClient(): SupabaseClient | null {
  if (typeof window !== "undefined") return null;
  if (!isSnapshotV3ShadowEnabled()) return null;
  if (shadowClient) return shadowClient;

  const shadowUrl = process.env[SNAPSHOT_V3_SUPABASE_URL_ENV];
  const shadowServiceRoleKey = process.env[SNAPSHOT_V3_SUPABASE_SERVICE_ROLE_KEY_ENV];

  if (!shadowUrl || !shadowServiceRoleKey) return null;

  // A dedicated project is required. Never silently point V3 at the primary.
  if (shadowUrl === process.env.NEXT_PUBLIC_SUPABASE_URL) return null;

  shadowClient = createClient(shadowUrl, shadowServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return shadowClient;
}
