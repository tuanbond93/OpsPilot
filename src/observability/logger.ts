import { getCorrelationId } from '@/observability/context';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  timestamp: string; // ISO string
  level: LogLevel;
  message?: string;
  // optional structured fields – callers may pass an object as second argument
  meta?: Record<string, unknown>;
}

/**
 * Simple JSON logger that writes to stdout via `console.log`.
 * No external dependencies, no request‑scoped state.
 * Consumers can optionally pass a correlationId or other fields in `meta`.
 */
export const logger = {
  info: (msgOrEntry: any, meta?: Record<string, unknown>) => {
    const correlationId = getCorrelationId();
    let entry: any;
    if (typeof msgOrEntry === 'object' && msgOrEntry !== null && 'message' in msgOrEntry) {
      entry = { timestamp: new Date().toISOString(), level: 'info', ...msgOrEntry };
      if (correlationId) entry.correlationId = correlationId;
    } else {
      const enrichedMeta = correlationId ? { correlationId, ...(meta || {}) } : meta;
      entry = { timestamp: new Date().toISOString(), level: 'info', message: msgOrEntry, meta: enrichedMeta };
    }
    console.log(JSON.stringify(entry));
  },
  warn: (msgOrEntry: any, meta?: Record<string, unknown>) => {
    const correlationId = getCorrelationId();
    let entry: any;
    if (typeof msgOrEntry === 'object' && msgOrEntry !== null && 'message' in msgOrEntry) {
      entry = { timestamp: new Date().toISOString(), level: 'warn', ...msgOrEntry };
      if (correlationId) entry.correlationId = correlationId;
    } else {
      const enrichedMeta = correlationId ? { correlationId, ...(meta || {}) } : meta;
      entry = { timestamp: new Date().toISOString(), level: 'warn', message: msgOrEntry, meta: enrichedMeta };
    }
    console.warn(JSON.stringify(entry));
  },
  error: (msgOrEntry: any, meta?: Record<string, unknown>) => {
    const correlationId = getCorrelationId();
    let entry: any;
    if (typeof msgOrEntry === 'object' && msgOrEntry !== null && 'message' in msgOrEntry) {
      entry = { timestamp: new Date().toISOString(), level: 'error', ...msgOrEntry };
      if (correlationId) entry.correlationId = correlationId;
    } else {
      const enrichedMeta = correlationId ? { correlationId, ...(meta || {}) } : meta;
      entry = { timestamp: new Date().toISOString(), level: 'error', message: msgOrEntry, meta: enrichedMeta };
    }
    console.error(JSON.stringify(entry));
  },
  debug: (msgOrEntry: any, meta?: Record<string, unknown>) => {
    const correlationId = getCorrelationId();
    let entry: any;
    if (typeof msgOrEntry === 'object' && msgOrEntry !== null && 'message' in msgOrEntry) {
      entry = { timestamp: new Date().toISOString(), level: 'debug', ...msgOrEntry };
      if (correlationId) entry.correlationId = correlationId;
    } else {
      const enrichedMeta = correlationId ? { correlationId, ...(meta || {}) } : meta;
      entry = { timestamp: new Date().toISOString(), level: 'debug', message: msgOrEntry, meta: enrichedMeta };
    }
    console.debug(JSON.stringify(entry));
  },
};
