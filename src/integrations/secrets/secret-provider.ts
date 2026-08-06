/**
 * Production-ready Secret Manager providing typed environment variable access
 * with validation, fail-fast behavior, and environment awareness.
 */
export class SecretProvider {
  private static requiredKeys = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  ];

  private static productionKeys = [
    "SUPABASE_SERVICE_ROLE_KEY",
    "CRON_SECRET",
  ];

  /**
   * Validates that all required secrets are present.
   * Fails fast if a required secret is missing in the current environment.
   */
  static validate(): { ok: boolean; missing: string[]; errors: string[] } {
    const missing: string[] = [];
    const errors: string[] = [];
    const isProd = process.env.NODE_ENV === "production";

    // Validate global required keys
    for (const key of this.requiredKeys) {
      if (!process.env[key]) {
        missing.push(key);
        errors.push(`Missing required secret: ${key}`);
      }
    }

    // Validate production keys only in production
    if (isProd) {
      for (const key of this.productionKeys) {
        if (!process.env[key]) {
          missing.push(key);
          errors.push(`Missing required production secret: ${key}`);
        }
      }
    }

    // Validate provider specific keys if defined
    const provider = process.env.AI_PROVIDER || "openai";
    if (provider === "openai" && !process.env.OPENAI_API_KEY) {
      // In prod/dev, OpenAI needs its API key unless fallback is allowed
      if (isProd || !process.env.ALLOW_IN_MEMORY_FALLBACK) {
        missing.push("OPENAI_API_KEY");
        errors.push("Missing required secret OPENAI_API_KEY when AI_PROVIDER is openai");
      }
    } else if (provider === "gemini" && !process.env.GOOGLE_AI_API_KEY) {
      if (isProd || !process.env.ALLOW_IN_MEMORY_FALLBACK) {
        missing.push("GOOGLE_AI_API_KEY");
        errors.push("Missing required secret GOOGLE_AI_API_KEY when AI_PROVIDER is gemini");
      }
    }

    return {
      ok: errors.length === 0,
      missing,
      errors,
    };
  }

  static get(key: string, defaultValue?: string): string {
    const val = process.env[key];
    if (val !== undefined && val !== "") return val;
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Required environment secret '${key}' is not defined.`);
  }

  static getOptional(key: string, defaultValue = ""): string {
    return process.env[key] || defaultValue;
  }

  static getBoolean(key: string, defaultValue = false): boolean {
    const val = process.env[key];
    if (val === undefined || val === "") return defaultValue;
    return val.toLowerCase() === "true" || val === "1";
  }

  static getNumber(key: string, defaultValue: number): number {
    const val = process.env[key];
    if (val === undefined || val === "") return defaultValue;
    const num = Number(val);
    return isNaN(num) ? defaultValue : num;
  }
}
