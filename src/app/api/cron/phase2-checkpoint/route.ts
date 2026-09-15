import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { authorizeApiRequest, isCronAuthorized } from "@/security/api-security";
import { NearTermCapacityRuntimeService } from "@/services/near-term-capacity-runtime";
import { claimPhase2CheckpointWork, finishPhase2CheckpointWork, phase2FailureOutcome } from "@/services/phase2-checkpoint-work";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function requestIdentity(request: NextRequest) {
  const checkpointAt = request.nextUrl.searchParams.get("checkpoint_at");
  const dispatchToken = request.headers.get("x-opspilot-phase2-token");
  if (!checkpointAt || !dispatchToken) return null;
  try { return { checkpointAt: new Date(checkpointAt).toISOString(), dispatchToken }; }
  catch { return null; }
}

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    const access = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 3, windowMs: 60_000 });
    if (!access.ok) return access.response;
  }
  const identity = requestIdentity(request);
  if (!identity) return NextResponse.json({ ok: false, error: "INVALID_PHASE2_WORK_REQUEST" }, { status: 400 });
  const client = createAdminClient();
  const claimed = await claimPhase2CheckpointWork(client, identity);
  if (!claimed) return NextResponse.json({ ok: true, stage: "PHASE2_ALREADY_CLAIMED" });
  try {
    const result = await new NearTermCapacityRuntimeService(client).runCheckpoint("phase2_checkpoint");
    await finishPhase2CheckpointWork(client, { ...identity, outcome: "COMPLETED" });
    return NextResponse.json({ ok: true, stage: "PHASE2_COMPLETED", result });
  } catch (error) {
    const outcome = phase2FailureOutcome(error);
    await finishPhase2CheckpointWork(client, { ...identity, outcome, error });
    return NextResponse.json({ ok: false, stage: "PHASE2_FAILED", retryable: outcome === "RETRYABLE" }, { status: outcome === "RETRYABLE" ? 503 : 500 });
  }
}
