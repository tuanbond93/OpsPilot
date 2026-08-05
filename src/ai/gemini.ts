import type { AIProvider, AIResponse, GenerateOptions, UsageInfo } from "./types";

export class GeminiProvider implements AIProvider {
  readonly name = "gemini";

  private getApiKey(): string {
    const key = process.env.GOOGLE_AI_API_KEY;
    if (!key) {
      throw new Error("Missing GOOGLE_AI_API_KEY environment variable");
    }
    return key;
  }

  async generate(
    prompt: string,
    input?: Record<string, unknown> | string,
    options: GenerateOptions = {}
  ): Promise<AIResponse> {
    const apiKey = this.getApiKey();
    const model = options.model || "gemini-1.5-flash";

    let userContent = prompt;
    if (input) {
      const formattedInput = typeof input === "string" ? input : JSON.stringify(input, null, 2);
      userContent = `${prompt}\n\n### INPUT CONTEXT:\n${formattedInput}`;
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

    if (options.systemPrompt) {
      contents.push({
        role: "user",
        parts: [{ text: `System Instruction: ${options.systemPrompt}` }],
      });
    }

    contents.push({
      role: "user",
      parts: [{ text: userContent }],
    });

    const payload = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: options.maxTokens ?? 1000,
      },
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API request failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text || "";

    const usageMetadata = data.usageMetadata;
    const usage: UsageInfo = {
      promptTokens: usageMetadata?.promptTokenCount,
      completionTokens: usageMetadata?.candidatesTokenCount,
      totalTokens: usageMetadata?.totalTokenCount,
    };

    return {
      text,
      usage,
      model,
    };
  }
}
