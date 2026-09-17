import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { authorize, generate } = vi.hoisted(() => ({ authorize: vi.fn(), generate: vi.fn() }));
const cronAuthorized = vi.hoisted(() => vi.fn(() => false));
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/security/api-security", () => ({ authorizeApiRequest: authorize, isCronAuthorized: cronAuthorized }));
vi.mock("@/ai/gemini", () => ({ GeminiProvider: class { generate = generate; } }));
vi.stubGlobal("fetch", fetchMock);

import { GET } from "@/app/api/internal/ai/health/gemini/route";

function request(headers: Record<string, string> = {}) {
  return new NextRequest("https://example.test/api/internal/ai/health/gemini", { headers });
}

describe("internal Gemini health route", () => {
  beforeEach(() => { process.env.GOOGLE_AI_API_KEY = "test-key"; authorize.mockReset(); cronAuthorized.mockReturnValue(false); generate.mockReset(); fetchMock.mockReset(); fetchMock.mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: "models/gemini-2.0-flash", displayName: "Gemini 2.0 Flash", supportedGenerationMethods: ["generateContent"] }] }) }); });

  it("rejects unauthenticated requests before invoking Gemini", async () => {
    authorize.mockResolvedValue({ ok: false, response: Response.json({ error: "AUTHENTICATION_REQUIRED" }, { status: 401 }) });
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(generate).not.toHaveBeenCalled();
  });

  it("runs a tiny authenticated Gemini check with the fixed model", async () => {
    authorize.mockResolvedValue({ ok: true, identity: { role: "ADMIN" } });
    generate.mockResolvedValue({ text: '{"ok":true}', model: "gemini-2.5-flash" });
    const response = await GET(request({ authorization: "Bearer internal" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: "gemini", model: "gemini-2.5-flash", ok: true, httpStatus: 200, parseOk: true, errorCode: null });
    expect(generate).toHaveBeenCalledWith('Return JSON only: {"ok":true}', undefined, expect.objectContaining({ model: "gemini-2.5-flash", temperature: 0, retries: 0 }));
  });

  it("accepts the existing CRON_SECRET auth path without user-session auth", async () => {
    cronAuthorized.mockReturnValue(true);
    generate.mockResolvedValue({ text: '{"ok":true}', model: "gemini-2.5-flash" });
    const response = await GET(request({ authorization: "Bearer cron-secret" }));
    expect(response.status).toBe(200);
    expect(authorize).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.clone().json())).not.toContain("cron-secret");
  });

  it("rejects an invalid Bearer secret", async () => {
    authorize.mockResolvedValue({ ok: false, response: Response.json({ error: "AUTHENTICATION_REQUIRED" }, { status: 401 }) });
    const response = await GET(request({ authorization: "Bearer invalid" }));
    expect(response.status).toBe(401);
    expect(generate).not.toHaveBeenCalled();
  });

  it("lists sanitized models and probes only a validated requested model", async () => {
    authorize.mockResolvedValue({ ok: true, identity: { role: "ADMIN" } });
    generate.mockResolvedValue({ text: '{"ok":true}', model: "gemini-2.0-flash" });
    const listResponse = await GET(new NextRequest("https://example.test/api/internal/ai/health/gemini?mode=list"));
    expect(listResponse.status).toBe(200);
    const probeResponse = await GET(new NextRequest("https://example.test/api/internal/ai/health/gemini?mode=probe&model=gemini-2.0-flash"));
    expect(probeResponse.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await listResponse.json())).not.toContain("GOOGLE_AI_API_KEY");
  });

  it("rejects invalid mode or malformed model parameter", async () => {
    authorize.mockResolvedValue({ ok: true, identity: { role: "ADMIN" } });
    const invalidMode = await GET(new NextRequest("https://example.test/api/internal/ai/health/gemini?mode=unknown"));
    expect(invalidMode.status).toBe(400);
    expect(await invalidMode.json()).toEqual({ error: "INVALID_MODE" });

    const invalidModel = await GET(new NextRequest("https://example.test/api/internal/ai/health/gemini?mode=probe&model=../evil/model"));
    expect(invalidModel.status).toBe(400);
    expect(await invalidModel.json()).toEqual({ error: "INVALID_MODEL" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("handles markdown code fences in probe response", async () => {
    authorize.mockResolvedValue({ ok: true, identity: { role: "ADMIN" } });
    generate.mockResolvedValue({ text: '```json\n{"ok":true}\n```', model: "gemini-2.0-flash" });
    const probeResponse = await GET(new NextRequest("https://example.test/api/internal/ai/health/gemini?mode=probe&model=gemini-2.0-flash"));
    expect(probeResponse.status).toBe(200);
    const body = await probeResponse.json();
    expect(body.ok).toBe(true);
    expect(body.parseOk).toBe(true);
  });

  it("bounds discover mode to <= 5 candidates and stops on first success", async () => {
    authorize.mockResolvedValue({ ok: true, identity: { role: "ADMIN" } });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-2.0-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-1.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-1.5-flash-8b", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-2.0-flash-lite", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-extra-flash", supportedGenerationMethods: ["generateContent"] },
        ],
      }),
    });

    // First candidate fails (404), second candidate succeeds
    generate
      .mockRejectedValueOnce(new Error("Gemini API request failed (404)"))
      .mockResolvedValueOnce({ text: '{"ok":true}', model: "gemini-2.0-flash" });

    const discoverResponse = await GET(new NextRequest("https://example.test/api/internal/ai/health/gemini?mode=discover"));
    expect(discoverResponse.status).toBe(200);
    const body = await discoverResponse.json();
    expect(body.selectedModel).toBe("gemini-2.0-flash");
    expect(body.attempts).toHaveLength(2);
    expect(body.attempts[0].ok).toBe(false);
    expect(body.attempts[1].ok).toBe(true);
    // Verified stopped immediately on first success, never invoked candidate 3..6
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("normalizes failures without exposing secrets or upstream payloads", async () => {
    authorize.mockResolvedValue({ ok: true, identity: { role: "ADMIN" } });
    generate.mockRejectedValue(new Error("Gemini API request failed (403): secret-value"));
    const response = await GET(request());
    const body = await response.json();
    expect(response.status).toBe(502);
    expect(body).toEqual({ provider: "gemini", model: "gemini-2.5-flash", ok: false, httpStatus: 403, parseOk: false, errorCode: "UPSTREAM_HTTP_403" });
    expect(JSON.stringify(body)).not.toContain("secret-value");
  });
});
