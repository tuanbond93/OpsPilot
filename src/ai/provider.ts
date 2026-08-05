import fs from "fs";
import path from "path";
import type { AIProvider, AIResponse, GenerateOptions, PromptMetadata } from "./types";
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
 * Parses frontmatter metadata from markdown prompt file
 */
export function parsePromptMetadata(rawContent: string, defaultName: string): PromptMetadata {
  let content = rawContent.trim();
  let name = defaultName;
  let version = 1;
  let language = "vi";

  const frontmatterRegex = /^---\s*[\r\n]+([\s\S]*?)[\r\n]+---\s*[\r\n]*/;
  const match = content.match(frontmatterRegex);

  if (match) {
    const yamlBlock = match[1];
    content = content.replace(frontmatterRegex, "");

    const nameMatch = yamlBlock.match(/name:\s*([^\r\n]+)/);
    if (nameMatch) name = nameMatch[1].trim();

    const versionMatch = yamlBlock.match(/version:\s*([^\r\n]+)/);
    if (versionMatch) version = parseInt(versionMatch[1].trim(), 10) || 1;

    const langMatch = yamlBlock.match(/language:\s*([^\r\n]+)/);
    if (langMatch) language = langMatch[1].trim();
  }

  return {
    name,
    version,
    language,
    content: content.trim(),
  };
}

/**
 * Loads markdown prompt template from src/prompts/<name>.md
 * Returns PromptMetadata object or raw string if requested.
 */
export function loadPromptMetadata(name: string, variables?: Record<string, string>): PromptMetadata {
  const sanitizedName = name.replace(/\.md$/, "");
  const promptPath = path.join(process.cwd(), "src", "prompts", `${sanitizedName}.md`);

  if (!fs.existsSync(promptPath)) {
    throw new Error(`Prompt file not found: ${promptPath}`);
  }

  const raw = fs.readFileSync(promptPath, "utf-8");
  const meta = parsePromptMetadata(raw, sanitizedName);

  if (variables) {
    let content = meta.content;
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = new RegExp(`{{\\s*${key}\\s*}}`, "g");
      content = content.replace(placeholder, String(value));
    }
    meta.content = content;
  }

  return meta;
}

/**
 * Backward compatible loadPrompt function returning string content
 */
export function loadPrompt(name: string, variables?: Record<string, string>): string {
  const meta = loadPromptMetadata(name, variables);
  return meta.content;
}

/**
 * Provider-agnostic generate function
 */
export async function generate(
  promptNameOrText: string,
  input?: Record<string, unknown> | string,
  options: GenerateOptions & { provider?: string } = {}
): Promise<AIResponse> {
  let promptText = promptNameOrText;

  try {
    promptText = loadPrompt(promptNameOrText);
  } catch {
    // Raw prompt text fallback
  }

  const provider = getAIProvider(options.provider);
  return provider.generate(promptText, input, options);
}
