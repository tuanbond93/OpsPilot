/**
 * Enforces production fallback policy:
 * In-memory repository fallbacks may ONLY be used in tests, explicit development mode,
 * or when ALLOW_IN_MEMORY_FALLBACK is explicitly set to "true".
 */
export function isFallbackAllowed(): boolean {
  if (process.env.ALLOW_IN_MEMORY_FALLBACK === "true") return true;
  if (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development") return true;
  return false;
}
