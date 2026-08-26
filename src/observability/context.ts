// src/observability/context.ts
import { AsyncLocalStorage } from 'node:async_hooks';

// Use global crypto if available, fallback to a simple UUID generator
function generateUUID(): string {
  if (typeof (globalThis as any).crypto?.randomUUID === 'function') {
    return (globalThis as any).crypto.randomUUID();
  }
  // Simple fallback (not cryptographically strong) – acceptable for non‑edge server usage
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Request‑scoped context used for correlation and structured logging */
export type RequestContext = {
  correlationId: string;
  meta?: Record<string, unknown>;
};

const storage = new AsyncLocalStorage<RequestContext>();

/** Run a function within a new request context */
export function runWithContext<T>(fn: () => T, ctx?: Partial<RequestContext>): T {
  const baseContext: RequestContext = {
    correlationId: ctx?.correlationId ?? generateUUID(),
    meta: ctx?.meta ?? {},
  };
  return storage.run(baseContext, fn);
}

/** Set (or replace) the correlationId for the current request */
export function setCorrelationId(id: string): void {
  const current = storage.getStore();
  if (current) {
    current.correlationId = id;
  } else {
    // If no store exists, start a new one – useful for tests or non‑HTTP code paths
    storage.enterWith({ correlationId: id, meta: {} });
  }
}

/** Retrieve the correlationId for the current request, if any */
export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/** Retrieve the whole context (metadata) for the current request */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
