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
