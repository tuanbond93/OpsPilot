import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRequest, isCronAuthorized } from "@/security/api-security";
import { GeminiProvider } from "@/ai/gemini";

export const dynamic = "force-dynamic";

const MODEL = "gemini-2.5-flash";

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /missing GOOGLE_AI_API_KEY/i.test(error.message)) return "MISSING_API_KEY";
  if (error instanceof Error && /\((\d{3})\)/.test(error.message)) return `UPSTREAM_HTTP_${error.message.match(/\((\d{3})\)/)?.[1]}`;
  if (error instanceof Error && error.name === "AbortError") return "TIMEOUT";
  return "GEMINI_HEALTH_CHECK_FAILED";
}

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    const access = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 3, windowMs: 60_000 });
    if (!access.ok) return access.response;
  }

  try {
    const response = await new GeminiProvider().generate(
      'Return JSON only: {"ok":true}',
      undefined,
      { model: MODEL, temperature: 0, maxTokens: 32, timeoutMs: 20_000, retries: 0 },
    );
    let parsed: unknown;
    try { parsed = JSON.parse(response.text.trim()); } catch { parsed = null; }
    const ok = Boolean(parsed && typeof parsed === "object" && (parsed as { ok?: unknown }).ok === true);
    return NextResponse.json({ provider: "gemini", model: MODEL, ok, httpStatus: 200, parseOk: parsed !== null, errorCode: ok ? null : "INVALID_HEALTH_RESPONSE" }, { status: ok ? 200 : 502 });
  } catch (error) {
    return NextResponse.json({ provider: "gemini", model: MODEL, ok: false, httpStatus: 502, parseOk: false, errorCode: safeErrorCode(error) }, { status: 502 });
  }
}
