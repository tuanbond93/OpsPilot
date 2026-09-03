import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/connectors/supabase";
import { readJsonBody, authorizeApiRequest, resolveActor } from "@/security/api-security";
import { ServiceFactory } from "@/services/ServiceFactory";
import { DecisionTelegramRequestService } from "@/services/decision-telegram-shadow";
import { buildTelegramDecisionShadowTest } from "@/services/telegram-decision-shadow-test";
import type { Decision } from "@/domain/decision";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const auth = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 5, windowMs: 60_000 });
  if (!auth.ok) return auth.response;
  if (parsed.body.confirmation !== "CREATE_SHADOW_TEST") {
    return NextResponse.json({ error: "TEST_CONFIRMATION_REQUIRED", message: "Xác nhận tạo bài test shadow trước khi gửi Telegram." }, { status: 400 });
  }

  const actor = resolveActor(auth.identity, parsed.body.actor) || "telegram-shadow-test";
  const client = createAdminClient();
  const decisionResult = await ServiceFactory.getDecisionService(client).create(buildTelegramDecisionShadowTest(actor));
  if (!decisionResult.ok || !decisionResult.data) {
    return NextResponse.json({ error: decisionResult.error || "TEST_DECISION_CREATE_FAILED", message: decisionResult.message || "Không thể tạo decision test." }, { status: decisionResult.error === "WRITE_CONTROLS_DISABLED" ? 403 : 503 });
  }

  try {
    const dispatch = await new DecisionTelegramRequestService(client).createAndDispatch(decisionResult.data as Decision, null, actor);
    return NextResponse.json({ ok: true, decision: decisionResult.data, request: dispatch.request, idempotent: Boolean(decisionResult.idempotent || dispatch.idempotent) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "TEST_TELEGRAM_DISPATCH_FAILED", message, decisionId: (decisionResult.data as Decision).decisionId }, { status: 503 });
  }
}
