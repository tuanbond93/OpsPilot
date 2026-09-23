import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { authorizeApiRequest, readJsonBody } from "@/security/api-security";
import { queueCheckpointRecovery, type StaleRunRecoveryQueueResult } from "@/services/checkpoint-recovery";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_RESULT = new Set(["QUEUED", "ALREADY_QUEUED", "REJECTED"]);

function isQueueResult(value: unknown): value is StaleRunRecoveryQueueResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<StaleRunRecoveryQueueResult>;
  return typeof result.outcome === "string"
    && ALLOWED_RESULT.has(result.outcome)
    && (result.code === null || typeof result.code === "string")
    && (result.syncRunId === null || typeof result.syncRunId === "string")
    && (result.checkpointAt === null || typeof result.checkpointAt === "string")
    && (result.recoveryStatus === null || typeof result.recoveryStatus === "string")
    && (result.recoveryAttempt === null || typeof result.recoveryAttempt === "number")
    && typeof result.tokenPresent === "boolean";
}

function rejectionStatus(code: string | null): number {
  if (code === "RUN_NOT_FOUND") return 404;
  return 409;
}

export async function POST(request: NextRequest) {
  const auth = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 5, windowMs: 60_000 });
  if (!auth.ok) return auth.response;

  const parsed = await readJsonBody(request, 4096);
  if (!parsed.ok) return parsed.response;
  const keys = Object.keys(parsed.body);
  if (keys.length !== 1 || keys[0] !== "syncRunId") {
    return NextResponse.json({ error: "SYNC_RUN_ID_ONLY_SUPPORTED" }, { status: 400 });
  }

  const syncRunId = typeof parsed.body.syncRunId === "string" ? parsed.body.syncRunId.trim() : "";
  if (!UUID_PATTERN.test(syncRunId)) {
    return NextResponse.json({ error: "INVALID_SYNC_RUN_ID" }, { status: 400 });
  }

  try {
    const result = await queueCheckpointRecovery(createAdminClient(), { syncRunId });
    if (!isQueueResult(result)) {
      return NextResponse.json({ error: "RECOVERY_QUEUE_UNAVAILABLE" }, { status: 503 });
    }

    console.info(JSON.stringify({
      category: "ADMIN_AUDIT",
      event: "CHECKPOINT_RECOVERY_OPERATOR_REQUEST",
      actor: auth.identity?.actor || null,
      syncRunId,
      checkpointAt: result.checkpointAt,
      outcome: result.outcome,
      recoveryStatus: result.recoveryStatus,
      occurredAt: new Date().toISOString(),
    }));

    if (result.outcome === "REJECTED") {
      return NextResponse.json({ ok: false, code: result.code || "RECOVERY_NOT_ALLOWED" }, { status: rejectionStatus(result.code) });
    }

    return NextResponse.json({
      ok: true,
      outcome: result.outcome,
      syncRunId: result.syncRunId,
      checkpointAt: result.checkpointAt,
      recoveryStatus: result.recoveryStatus,
      recoveryAttempt: result.recoveryAttempt,
      tokenPresent: result.tokenPresent,
    }, { status: result.outcome === "QUEUED" ? 202 : 200 });
  } catch {
    return NextResponse.json({ error: "RECOVERY_QUEUE_UNAVAILABLE" }, { status: 503 });
  }
}
