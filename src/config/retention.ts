/** Canonical operational retention contract for raw order-level snapshots. */
export const ORDER_SNAPSHOT_RETENTION_DAYS = 21;
export const ORDER_SNAPSHOT_RETENTION_MS = ORDER_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type RawOrderDetailStatus = "AVAILABLE" | "EXPIRED_BY_RETENTION" | "NOT_FOUND";

export function isWithinOrderSnapshotRetention(timestamp: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (!timestamp) return false;
  const value = timestamp instanceof Date ? timestamp.getTime() : Date.parse(timestamp);
  return Number.isFinite(value) && now.getTime() - value <= ORDER_SNAPSHOT_RETENTION_MS;
}

export function classifyRawOrderDetail(historicalTimestamp: string | Date | null | undefined, rowsFound: boolean, now: Date = new Date()): RawOrderDetailStatus {
  if (rowsFound) return "AVAILABLE";
  if (!historicalTimestamp) return "NOT_FOUND";
  const value = historicalTimestamp instanceof Date ? historicalTimestamp.getTime() : Date.parse(historicalTimestamp);
  if (!Number.isFinite(value)) return "NOT_FOUND";
  return isWithinOrderSnapshotRetention(historicalTimestamp, now) ? "NOT_FOUND" : "EXPIRED_BY_RETENTION";
}
