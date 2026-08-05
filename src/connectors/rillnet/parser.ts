import { RillnetParseError, type RawRillnetOrder } from "./types";

/**
 * Parses raw JSON string into array of RawRillnetOrder objects
 */
export function parseSnapshot(jsonText: string): RawRillnetOrder[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RillnetParseError(`Invalid JSON format in Rillnet snapshot: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new RillnetParseError("Parsed Rillnet snapshot root element is not an array");
  }

  return parsed as RawRillnetOrder[];
}
