import { NextRequest, NextResponse } from "next/server";
import { collectCheckpointEvidence } from "@/services/checkpoint-observability";
import { authorizeApiRequest } from "@/security/api-security";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store, max-age=0" };
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;

function normalizeCheckpointTimestamp(value: string | null): string | null {
  if (!value || !timestampPattern.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export async function GET(request: NextRequest) {
  const auth = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 30, windowMs: 60_000 });
  if (!auth.ok) return auth.response;

  const checkpointAt = normalizeCheckpointTimestamp(
    request.nextUrl.searchParams.get("checkpointAt"),
  );
  if (!checkpointAt) {
    return NextResponse.json(
      { error: "INVALID_CHECKPOINT_TIMESTAMP", message: "checkpointAt must be an ISO timestamp with a timezone." },
      { status: 400, headers: noStore },
    );
  }

  try {
    const evidence = await collectCheckpointEvidence(checkpointAt);
    return NextResponse.json({ ok: true, evidence }, { headers: noStore });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "OBSERVABILITY_READ_UNAVAILABLE",
        observability_status: "BLOCKED",
      },
      { status: 503, headers: noStore },
    );
  }
}

function methodNotAllowed(_request: NextRequest) {
  return NextResponse.json(
    { error: "METHOD_NOT_ALLOWED", allowed: ["GET"] },
    { status: 405, headers: { ...noStore, Allow: "GET" } },
  );
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
