import fs from "fs";
import path from "path";
import type { AIProvider, AIResponse, GenerateOptions } from "./types";
import { OpenAIProvider } from "./openai";
import { GeminiProvider } from "./gemini";

const providerRegistry: Record<string, AIProvider> = {
  openai: new OpenAIProvider(),
  gemini: new GeminiProvider(),
};

/**
 * Registers a custom AI provider instance (e.g. Claude, OpenRouter, Local LLM)
 */
export function registerAIProvider(provider: AIProvider): void {
  providerRegistry[provider.name.toLowerCase()] = provider;
}

/**
 * Resolves the active AI provider based on parameter or process.env.AI_PROVIDER
 */
export function getAIProvider(providerName?: string): AIProvider {
  const name = (providerName || process.env.AI_PROVIDER || "openai").toLowerCase().trim();
  const provider = providerRegistry[name];

  if (!provider) {
    throw new Error(
      `Unsupported AI provider: '${name}'. Supported providers: ${Object.keys(providerRegistry).join(", ")}`
    );
  }

  return provider;
}

/**
 * Loads markdown prompt template from src/prompts/<name>.md
 * Interpolates {{variable}} placeholders if variables map is provided.
 */
export function loadPrompt(name: string, variables?: Record<string, string>): string {
  const sanitizedName = name.replace(/\.md$/, "");
  const promptPath = path.join(process.cwd(), "src", "prompts", `${sanitizedName}.md`);

  if (!fs.existsSync(promptPath)) {
    throw new Error(`Prompt file not found: ${promptPath}`);
  }

  let content = fs.readFileSync(promptPath, "utf-8");

  if (variables) {
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = new RegExp(`{{\\s*${key}\\s*}}`, "g");
      content = content.replace(placeholder, String(value));
    }
  }

  return content;
}

/**
 * Provider-agnostic generate function
 * Loads prompt template, formats input, and calls active AIProvider
 */
export async function generate(
  promptNameOrText: string,
  input?: Record<string, unknown> | string,
  options: GenerateOptions & { provider?: string } = {}
): Promise<AIResponse> {
  let promptText = promptNameOrText;

  // If promptName matches a file in src/prompts, load it via loadPrompt
  try {
    promptText = loadPrompt(promptNameOrText);
  } catch {
    // If not a prompt file name, use raw text directly
  }

  const provider = getAIProvider(options.provider);
  return provider.generate(promptText, input, options);
}
