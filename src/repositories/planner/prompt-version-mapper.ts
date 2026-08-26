// src/repositories/planner/prompt-version-mapper.ts

/**
 * Strict mapper between numeric DB representation of prompt version
 * and the string domain representation used throughout the application.
 *
 * Expected pattern for the string version: ^v[1-9][0-9]*$
 *   e.g. "v1", "v2", "v10"
 *
 * The numeric value must be a positive integer (>=1).
 */

const VERSION_REGEX = /^v([1-9][0-9]*)$/;

/**
 * Convert a numeric DB value to a domain string version.
 * Throws if the input is not a valid positive integer.
 */
export function deserializePromptVersion(value: number): string {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid prompt version number ${value}`);
  }
  return `v${value}`;
}

/**
 * Convert a domain string version to the numeric DB representation.
 * Validates the string against the strict regex.
 */
export function serializePromptVersion(value: string): number {
  const match = VERSION_REGEX.exec(value);
  if (!match) {
    throw new Error(`Invalid prompt version string "${value}"`);
  }
  const num = Number(match[1]);
  if (!Number.isInteger(num) || num < 1) {
    throw new Error(`Invalid prompt version number derived from "${value}"`);
  }
  return num;
}

const promptVersionMapper = {
  deserializePromptVersion,
  serializePromptVersion,
};
export default promptVersionMapper;
