import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { normalizeOpsRole, roleCan, roleFromMetadata, type OpsPermission, type OpsRole } from "@/security/roles";

export { normalizeOpsRole, roleCan, roleFromMetadata } from "@/security/roles";
export type { OpsPermission, OpsRole } from "@/security/roles";

type RateBucket = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateBucket>();
const MAX_RATE_BUCKETS = 2000;

export function isAuthEnforced() {
  return process.env.AUTH_ENFORCEMENT_ENABLED === "true";
}

export function isCronAuthorized(request: Pick<NextRequest, "headers">) {
  const cronSecret = process.env.CRON_SECRET;
  return Boolean(cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`);
}

export function consumeRateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  const prior = rateBuckets.get(key);
  if (!prior || prior.resetAt <= now) {
    if (rateBuckets.size >= MAX_RATE_BUCKETS) {
      for (const [bucketKey, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(bucketKey);
      if (rateBuckets.size >= MAX_RATE_BUCKETS) rateBuckets.delete(rateBuckets.keys().next().value as string);
    }
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: Math.max(0, limit - 1), resetAt: now + windowMs };
  }
  prior.count += 1;
  return { allowed: prior.count <= limit, remaining: Math.max(0, limit - prior.count), resetAt: prior.resetAt };
}

export function resetRateLimitsForTests() {
  rateBuckets.clear();
}

export function validateMutationRequest(request: Pick<NextRequest, "headers" | "url">, maxBytes = 32_768) {
  const length = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > maxBytes) return { ok: false as const, status: 413, error: "PAYLOAD_TOO_LARGE" };
  if (isAuthEnforced()) {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) return { ok: false as const, status: 403, error: "ORIGIN_NOT_ALLOWED" };
  }
  return { ok: true as const };
}

export async function readJsonBody(request: NextRequest, maxBytes = 32_768): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  const guard = validateMutationRequest(request, maxBytes);
  if (!guard.ok) return { ok: false, response: NextResponse.json({ error: guard.error }, { status: guard.status }) };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) return { ok: false, response: NextResponse.json({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 }) };
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "INVALID_JSON", message: "A JSON object body is required." }, { status: 400 }) };
  }
}

export async function authorizeApiRequest(request: NextRequest, permission: OpsPermission, rate = { limit: 60, windowMs: 60_000 }) {
  if (!isAuthEnforced()) return { ok: true as const, identity: null };
  const mutationGuard = validateMutationRequest(request);
  if (!mutationGuard.ok) return { ok: false as const, response: NextResponse.json({ error: mutationGuard.error }, { status: mutationGuard.status }) };
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  const bucket = consumeRateLimit(`${permission}:${ip}`, rate.limit, rate.windowMs);
  if (!bucket.allowed) return { ok: false as const, response: NextResponse.json({ error: "RATE_LIMITED", retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000)) }, { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000))) } }) };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return { ok: false as const, response: NextResponse.json({ error: "AUTHENTICATION_REQUIRED" }, { status: 401 }) };
    const role = roleFromMetadata(data.user.app_metadata, data.user.user_metadata);
    if (!roleCan(role, permission)) return { ok: false as const, response: NextResponse.json({ error: "PERMISSION_DENIED", requiredPermission: permission }, { status: 403 }) };
    return { ok: true as const, identity: { userId: data.user.id, actor: data.user.email || data.user.id, role, appMetadata: data.user.app_metadata, userMetadata: data.user.user_metadata } };
  } catch {
    return { ok: false as const, response: NextResponse.json({ error: "AUTH_SERVICE_UNAVAILABLE" }, { status: 503 }) };
  }
}

export function resolveActor(identity: { actor: string } | null, legacyActor: unknown) {
  if (identity) return identity.actor;
  return typeof legacyActor === "string" ? legacyActor.trim() : "";
}
