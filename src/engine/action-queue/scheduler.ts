export class ActionScheduler {
  /**
   * Determines if a scheduled action is due for processing
   */
  static isActionReady(scheduledAtIso: string, referenceTimeMs: number = Date.now()): boolean {
    const scheduledTimeMs = new Date(scheduledAtIso).getTime();
    return scheduledTimeMs <= referenceTimeMs;
  }
}
