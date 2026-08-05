import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getAIProvider,
  registerAIProvider,
  loadPrompt,
  generate,
  type AIProvider,
  type AIResponse,
} from "../ai";

describe("Sprint 4.1: AI Foundation & Provider Abstraction Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads prompt markdown template from src/prompts directory", () => {
    const promptText = loadPrompt("rootcause");
    expect(promptText).toContain("# System Prompt: OpsPilot Root Cause Explanation Agent");
    expect(promptText).toContain("STRICT HALLUCINATION GUARD & NON-GOAL CONSTRAINTS");
  });

  it("interpolates template variables in prompt loader", () => {
    const promptText = loadPrompt("message", {
      reasonName: "Kho chưa lấy",
      warehouseName: "Kho Phú Thọ",
      affectedOrderCount: "42",
    });

    expect(promptText).toContain("- Incident Reason: Kho chưa lấy");
    expect(promptText).toContain("- Warehouse Name: Kho Phú Thọ");
    expect(promptText).toContain("- Affected Order Count: 42");
  });

  it("resolves default AI provider (openai) from getAIProvider()", () => {
    delete process.env.AI_PROVIDER;
    const provider = getAIProvider();
    expect(provider.name).toBe("openai");
  });

  it("switches AI provider dynamically to gemini when requested", () => {
    const provider = getAIProvider("gemini");
    expect(provider.name).toBe("gemini");
  });

  it("throws clear error for unsupported provider names", () => {
    expect(() => getAIProvider("unsupported_llm")).toThrowError(
      /Unsupported AI provider: 'unsupported_llm'/
    );
  });

  it("supports registering custom AI providers (e.g. Claude / OpenRouter)", () => {
    const mockClaudeProvider: AIProvider = {
      name: "claude",
      generate: async () => ({
        text: "Claude response",
        model: "claude-3-5-sonnet",
      }),
    };

    registerAIProvider(mockClaudeProvider);

    const provider = getAIProvider("claude");
    expect(provider.name).toBe("claude");
  });

  it("generate() calls active provider without real network request", async () => {
    const mockResponse: AIResponse = {
      text: "Mocked AI operational analysis",
      usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
      model: "mock-llm-v1",
    };

    const mockProvider: AIProvider = {
      name: "mock-provider",
      generate: vi.fn().mockResolvedValue(mockResponse),
    };

    registerAIProvider(mockProvider);

    const result = await generate("summary", { incidentCount: 10 }, { provider: "mock-provider" });

    expect(mockProvider.generate).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Mocked AI operational analysis");
    expect(result.model).toBe("mock-llm-v1");
  });
});
