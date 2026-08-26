export interface PromptDefinition {
  readonly id: string;
  readonly version: string; // e.g. "v1"
  readonly description: string;
  readonly prompt: string;
}
