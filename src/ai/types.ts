export interface UsageInfo {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AIResponse {
  text: string;
  usage?: UsageInfo;
  model: string;
}

export interface GenerateOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface AIProvider {
  readonly name: string;
  generate(
    prompt: string,
    input?: Record<string, unknown> | string,
    options?: GenerateOptions
  ): Promise<AIResponse>;
}
