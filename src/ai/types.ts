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
  timeoutMs?: number; // Default 20000 (20s)
  retries?: number; // Default 1
}

export interface PromptMetadata {
  name: string;
  version: string;
  language: string;
  content: string;
}

export interface AIProvider {
  readonly name: string;
  generate(
    prompt: string,
    input?: Record<string, unknown> | string,
    options?: GenerateOptions
  ): Promise<AIResponse>;
}
