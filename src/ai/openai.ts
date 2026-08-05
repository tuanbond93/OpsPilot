import type { AIProvider, AIResponse, GenerateOptions, UsageInfo } from "./types";

export class OpenAIProvider implements AIProvider {
  readonly name = "openai";

  private getApiKey(): string {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error("Missing OPENAI_API_KEY environment variable");
    }
    return key;
  }

  async generate(
    prompt: string,
    input?: Record<string, unknown> | string,
    options: GenerateOptions = {}
  ): Promise<AIResponse> {
    const apiKey = this.getApiKey();
    const model = options.model || "gpt-4o-mini";
    const timeoutMs = options.timeoutMs ?? 20000;
    const maxRetries = options.retries ?? 1;

    let userContent = prompt;
    if (input) {
      const formattedInput = typeof input === "string" ? input : JSON.stringify(input, null, 2);
      userContent = `${prompt}\n\n### INPUT CONTEXT:\n${formattedInput}`;
    }

    const messages: Array<{ role: "system" | "user"; content: string }> = [];

    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: userContent });

    const payload = {
      model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 1000,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`OpenAI API request failed (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        const text = data.choices?.[0]?.message?.content || "";

        const usage: UsageInfo = {
          promptTokens: data.usage?.prompt_tokens,
          completionTokens: data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens,
        };

        return {
          text,
          usage,
          model: data.model || model,
        };
      } catch (err: unknown) {
        clearTimeout(timer);
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === maxRetries) break;
      }
    }

    throw lastError || new Error("OpenAI API call failed after retries");
  }
}
