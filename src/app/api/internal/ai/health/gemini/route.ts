import { NextRequest, NextResponse } from "next/server";
import { authorizeApiRequest, isCronAuthorized } from "@/security/api-security";
import { GeminiProvider } from "@/ai/gemini";

export const dynamic = "force-dynamic";

const MODEL = "gemini-2.5-flash";
const MAX_MODELS = 50;
const MAX_PROBES = 5;

type ListedModel = { name?: string; displayName?: string; supportedGenerationMethods?: string[] };

function modelId(name: string) { return name.replace(/^models\//, ""); }
function validModel(value: string) { return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(value) && !value.includes("/"); }

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /missing GOOGLE_AI_API_KEY/i.test(error.message)) return "MISSING_API_KEY";
  if (error instanceof Error && /\((\d{3})\)/.test(error.message)) return `UPSTREAM_HTTP_${error.message.match(/\((\d{3})\)/)?.[1]}`;
  if (error instanceof Error && error.name === "AbortError") return "TIMEOUT";
  return "GEMINI_HEALTH_CHECK_FAILED";
}

async function listModels(): Promise<ListedModel[]> {
  const key = process.env.GOOGLE_AI_API_KEY;
  if (!key) throw new Error("Missing GOOGLE_AI_API_KEY environment variable");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=50&key=${encodeURIComponent(key)}`, { method: "GET" });
  if (!response.ok) throw new Error(`Gemini API request failed (${response.status})`);
  const data = await response.json() as { models?: ListedModel[] };
  return (data.models || []).slice(0, MAX_MODELS);
}

function safeModelMetadata(models: ListedModel[]) {
  return models
    .filter((item) => typeof item.name === "string")
    .map((item) => ({
      model_id: modelId(item.name as string),
      display_name_safe: typeof item.displayName === "string" ? item.displayName : null,
      supported_generation_methods: Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : [],
      generate_content_supported: Array.isArray(item.supportedGenerationMethods) && item.supportedGenerationMethods.includes("generateContent"),
    }))
    .filter((item) => item.model_id.length > 0);
}

async function probeModel(model: string) {
  try {
    const response = await new GeminiProvider().generate('Return JSON only: {"ok":true}', undefined, { model, temperature: 0, maxTokens: 32, timeoutMs: 20_000, retries: 0 });
    let parsed: unknown;
    try { parsed = JSON.parse(response.text.replace(/```json|```/gi, "").trim()); } catch { parsed = null; }
    const ok = Boolean(parsed && typeof parsed === "object" && (parsed as { ok?: unknown }).ok === true);
    return { provider: "gemini", model, ok, httpStatus: 200, parseOk: parsed !== null, errorCode: ok ? null : "INVALID_HEALTH_RESPONSE" };
  } catch (error) {
    const code = safeErrorCode(error);
    const status = error instanceof Error ? Number(error.message.match(/\((\d{3})\)/)?.[1] || 502) : 502;
    return { provider: "gemini", model, ok: false, httpStatus: status, parseOk: false, errorCode: code };
  }
}

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    const access = await authorizeApiRequest(request, "MANAGE_SYSTEM", { limit: 3, windowMs: 60_000 });
    if (!access.ok) return access.response;
  }

  const mode = request.nextUrl.searchParams.get("mode") || "health";
  if (!["health", "list", "probe", "discover"].includes(mode)) return NextResponse.json({ error: "INVALID_MODE" }, { status: 400 });
  try {
    if (mode === "health") {
      const result = await probeModel(MODEL);
      return NextResponse.json(result, { status: result.ok ? 200 : 502 });
    }
    const models = safeModelMetadata(await listModels());
    if (mode === "list") return NextResponse.json({ provider: "gemini", models });
    const requested = request.nextUrl.searchParams.get("model") || "";
    if (mode === "probe") {
      if (!validModel(requested)) return NextResponse.json({ error: "INVALID_MODEL" }, { status: 400 });
      const result = await probeModel(requested);
      return NextResponse.json(result, { status: result.ok ? 200 : 502 });
    }
    const candidates = models.filter((item) => item.generate_content_supported && /flash/i.test(item.model_id)).slice(0, MAX_PROBES);
    const attempts = [];
    for (const candidate of candidates) {
      const result = await probeModel(candidate.model_id);
      attempts.push(result);
      if (result.ok) return NextResponse.json({ provider: "gemini", selectedModel: candidate.model_id, attempts, models: models.filter((item) => /flash/i.test(item.model_id)) });
    }
    return NextResponse.json({ provider: "gemini", selectedModel: null, attempts, models: models.filter((item) => /flash/i.test(item.model_id)) }, { status: 502 });
  } catch (error) {
    return NextResponse.json({ provider: "gemini", model: MODEL, ok: false, httpStatus: 502, parseOk: false, errorCode: safeErrorCode(error) }, { status: 502 });
  }
}
