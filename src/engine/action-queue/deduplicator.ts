import type { ActionType } from "./types";

export class Deduplicator {
  private static memoryKeys = new Set<string>();

  /**
   * Generates a deterministic deduplication key for an incident notification action
   * Format: incidentId:actionType:version
   */
  static generateKey(incidentId: string, actionType: ActionType, version: string | number = "v1"): string {
    return `${incidentId}:${actionType}:${version}`;
  }

  /**
   * Checks if a key has already been enqueued in memory
   */
  static isDuplicateInMemory(key: string): boolean {
    return this.memoryKeys.has(key);
  }

  /**
   * Marks a key as enqueued in memory
   */
  static markKeyInMemory(key: string): void {
    this.memoryKeys.add(key);
  }

  /**
   * Clears memory deduplication cache (useful for testing)
   */
  static clearMemory(): void {
    this.memoryKeys.clear();
  }
}
