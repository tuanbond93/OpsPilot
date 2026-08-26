import { NextRequest, NextResponse } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';
import { roleCan, roleFromMetadata } from '@/security/roles';
import { isProtectedApiPath, isProtectedPagePath, requiredPermissionForDebugMutation } from '@/security/route-policy';
import { emitEdgeSecurityAudit } from '@/security/edge-audit';
import { securityHeaders } from '@/security/security-headers';

const CORRELATION_HEADER = 'x-correlation-id';
// Simple UUID v4 validation (case‑insensitive)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Edge middleware that ensures every request has a correlation ID.
 * It validates an incoming `x-correlation-id` header, falls back to a generated UUID,
 * and mirrors the effective ID back in the response headers.
 */
export async function middleware(request: NextRequest) {
  const incoming = request.headers.get(CORRELATION_HEADER);
  const valid = incoming && UUID_REGEX.test(incoming);
  const correlationId = valid ? incoming! : (globalThis.crypto?.randomUUID?.() ?? '');
  const canRefreshSession = process.env.AUTH_ENFORCEMENT_ENABLED === 'true' && Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const session = canRefreshSession ? await updateSession(request) : { response: NextResponse.next(), user: null };
  const pathname = request.nextUrl.pathname;
  const protectedApi = isProtectedApiPath(pathname);
  const protectedPage = isProtectedPagePath(pathname);

  let response = session.response;
  if (canRefreshSession && !session.user && protectedApi) {
    emitEdgeSecurityAudit({ event: 'AUTHENTICATION_REQUIRED', path: pathname, method: request.method, correlationId });
    response = NextResponse.json({ error: 'AUTHENTICATION_REQUIRED' }, { status: 401 });
  } else if (canRefreshSession && !session.user && protectedPage) {
    const accountUrl = request.nextUrl.clone();
    accountUrl.pathname = '/account';
    accountUrl.search = `?next=${encodeURIComponent(pathname + request.nextUrl.search)}`;
    response = NextResponse.redirect(accountUrl);
  } else if (canRefreshSession && session.user) {
    const requiredPermission = requiredPermissionForDebugMutation(pathname, request.method);
    const role = roleFromMetadata(session.user.app_metadata, session.user.user_metadata);
    if (requiredPermission && !roleCan(role, requiredPermission)) {
      emitEdgeSecurityAudit({ event: 'PERMISSION_DENIED', path: pathname, method: request.method, correlationId, role, subjectId: session.user.id, requiredPermission });
      response = NextResponse.json({ error: 'PERMISSION_DENIED', requiredPermission }, { status: 403 });
    }
  }
  response.headers.set(CORRELATION_HEADER, correlationId);
  for (const [name, value] of Object.entries(securityHeaders())) response.headers.set(name, value);
  if (response.status === 401 || response.status === 403) response.headers.set('cache-control', 'no-store');
  return response;
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
};
