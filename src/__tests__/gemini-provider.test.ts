import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "../ai/gemini";

describe("GeminiProvider model and request contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AI_MODEL;
    delete process.env.GOOGLE_AI_API_KEY;
  });

  it("defaults to the supported Gemini Flash model and parses JSON text", async () => {
    process.env.GOOGLE_AI_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await new GeminiProvider().generate("return json", undefined, { temperature: 0, maxTokens: 10 });

    expect(response.model).toBe("gemini-flash-lite-latest");
    expect(JSON.parse(response.text)).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toContain("/v1beta/models/gemini-flash-lite-latest:generateContent");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
  });

  it("honors AI_MODEL and preserves retry/error behavior", async () => {
    process.env.GOOGLE_AI_API_KEY = "test-key";
    process.env.AI_MODEL = "gemini-2.5-flash-lite";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await new GeminiProvider().generate("return json", undefined, { retries: 1 });

    expect(response.model).toBe("gemini-2.5-flash-lite");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
