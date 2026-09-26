import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";

const { authorizeMock, collectMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  collectMock: vi.fn(),
}));

vi.mock("@/security/api-security", () => ({ authorizeApiRequest: authorizeMock }));
vi.mock("server-only", () => ({}));
vi.mock("@/services/checkpoint-observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/checkpoint-observability")>()),
  collectCheckpointEvidence: collectMock,
}));

import { DELETE, GET, PATCH, POST, PUT } from "@/app/api/internal/observability/checkpoint/route";

let collectReal!: typeof import("@/services/checkpoint-observability").collectCheckpointEvidence;
let redactReal!: typeof import("@/services/checkpoint-observability").redactDiagnosticMessage;
beforeAll(async () => {
  const actual = await vi.importActual<typeof import("@/services/checkpoint-observability")>("@/services/checkpoint-observability");
  collectReal = actual.collectCheckpointEvidence;
  redactReal = actual.redactDiagnosticMessage;
});

const CHECKPOINT = "2026-09-26T01:00:00.000Z";
const FIXED_NOW = new Date("2026-09-26T02:00:00.000Z");

function request(method = "GET", url = `https://opspilot.test/api/internal/observability/checkpoint?checkpointAt=${CHECKPOINT}`,
  authorization = "Bearer admin-token") {
  return new NextRequest(url, { method, headers: authorization ? { authorization } : {} });
}

function queryBuilder(table: string, queryLog: Array<{ table: string; method: string; args: unknown[] }>, resolve: () => unknown) {
  const filters: Array<[string, ...unknown[]]> = [];
  const builder: any = {};
  for (const method of ["eq", "in", "contains", "gte", "lte", "order", "limit", "select"]) {
    builder[method] = vi.fn((...args: unknown[]) => {
      queryLog.push({ table, method, args });
      if (["eq", "in", "contains", "gte", "lte"].includes(method)) filters.push([method, ...args]);
      return builder;
    });
  }
  const resultPayload = () => {
    const value = resolve() as any;
    if (value && typeof value === "object" && "data" in value && "error" in value) return value;
    return { data: value, error: null, count: null };
  };
  builder.maybeSingle = vi.fn(() => {
    queryLog.push({ table, method: "maybeSingle", args: [] });
    const result = resultPayload();
    return Promise.resolve({ ...result, data: Array.isArray(result.data) ? result.data[0] ?? null : result.data });
  });
  builder.then = (fulfilled: (value: unknown) => unknown, rejected: (reason: unknown) => unknown) =>
    Promise.resolve(resultPayload()).then(fulfilled, rejected);
  return { builder, filters };
}

function evidenceClient(overrides: Record<string, unknown> = {}) {
  const queryLog: Array<{ table: string; method: string; args: unknown[] }> = [];
  const run = {
    id: "run-08h-001",
    checkpoint_at: CHECKPOINT,
    status: "success",
    current_phase: "COMPLETED",
    completed_phases: ["FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS", "COMPLETED"],
    started_at: "2026-09-26T01:00:01.000Z",
    completed_at: "2026-09-26T01:02:00.000Z",
    duration_ms: 119000,
    error_code: null,
    error_message: null,
    fetched_order_count: 2,
  };
  const rows: Record<string, unknown> = {
    sync_runs: [run],
    sync_locks: { lock_key: "global:rillnet-sync", owner_id: "owner_20260926", acquired_at: "2026-09-26T01:00:01.000Z", expires_at: "2026-09-26T03:00:00.000Z", heartbeat_at: "2026-09-26T01:01:00.000Z" },
    checkpoint_dispatch_audits: { sync_run_id: run.id, checkpoint_at: CHECKPOINT, started_at: "2026-09-26T01:02:00.000Z", completed_at: "2026-09-26T01:02:05.000Z", execution_status: "SUCCESS", http_status: 200, first_push_pending_created: 1, second_push_pending_created: 2, third_push_pending_created: 0, escalation_pending_created: 0, total_dispatch_eligible_pending: 3, send_attempts: 1, send_success: 1, send_failed: 0, status_updates_resolved: 1, error_code: null, error_message_safe: null, created_at: "2026-09-26T01:02:05.000Z" },
    checkpoint_recoveries: null,
    phase2_checkpoint_work: null,
    inbound_population_manifests: [{ source_system: "RILLNET", population_status: "COMPLETE", expected_observation_count: 2, persisted_observation_count: 2, duplicate_identical_count: 0, duplicate_conflict_count: 0, population_completed_at: "2026-09-26T01:01:30.000Z" }],
    inbound_order_observations: null,
    order_snapshots: null,
    telegram_incident_status_updates: [{ id: "status-id", status: "SENT", sent_at: "2026-09-26T01:02:02.000Z", telegram_message_id: 1087968824, updated_at: "2026-09-26T01:02:02.000Z", update_kind: "ACTIVE" }],
    telegram_sync_status_reports: [],
    followup_cases: [{ id: "case-id" }],
    telegram_rillnet_review_requests: [],
    telegram_followup_reminders: [{ id: "reminder-id", status: "FAILED", sent_at: null, telegram_message_id: null, updated_at: "2026-09-26T01:02:03.000Z" }],
    ...overrides,
  };
  const client = {
    from: vi.fn((table: string) => {
      const { builder, filters } = queryBuilder(table, queryLog, () => {
        let data = rows[table] ?? [];
        if (table === "sync_runs" && filters.some(([method, key]) => method === "eq" && key === "status")) {
          return { data: null, error: null, count: overrides.runningCount as number | undefined ?? 1 };
        }
        if (table === "inbound_order_observations" || table === "order_snapshots") {
          return { data: null, error: null, count: overrides[`${table}Count`] as number | undefined ?? 2 };
        }
        if (table === "checkpoint_dispatch_audits" || table === "checkpoint_recoveries" || table === "phase2_checkpoint_work" || table === "sync_locks") {
          return data;
        }
        if (table === "telegram_followup_reminders" && Array.isArray(data) && !filters.some(([method]) => method === "in")) return [];
        return data;
      });
      return builder;
    }),
    rpc: vi.fn((name: string, args: unknown) => {
      queryLog.push({ table: `rpc:${name}`, method: "rpc", args: [args] });
      if (overrides.cronError) return Promise.resolve({ data: null, error: { code: "42501", message: "denied" }, count: null });
      return Promise.resolve({
        data: overrides.cron ?? {
          job_found: true,
          job: { job_id: 14, job_name: "opspilot-followup-cycle-mb3", schedule: "0 1,3,5,7,9,11 * * *", active: true },
          runs: [{ job_id: 14, run_id: 9991, start_time: "2026-09-26T01:00:00.000Z", end_time: "2026-09-26T01:02:00.000Z", status: "succeeded", return_message: "ok" }],
        },
        error: null,
        count: null,
      });
    }),
  };
  return { client: client as any, queryLog, rows };
}

describe("GET /api/internal/observability/checkpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeMock.mockResolvedValue({ ok: true, identity: { role: "ADMIN" } });
    collectMock.mockResolvedValue({ metadata: { observability_status: "PASS" } });
  });

  it("denies an unauthenticated request", async () => {
    authorizeMock.mockResolvedValue({ ok: false, response: Response.json({ error: "AUTHENTICATION_REQUIRED" }, { status: 401 }) });
    const response = await GET(request("GET", undefined, ""));
    expect(response.status).toBe(401);
    expect(collectMock).not.toHaveBeenCalled();
  });

  it("denies ordinary authenticated users without MANAGE_SYSTEM", async () => {
    authorizeMock.mockResolvedValue({ ok: false, response: Response.json({ error: "PERMISSION_DENIED" }, { status: 403 }) });
    expect((await GET(request())).status).toBe(403);
    expect(authorizeMock).toHaveBeenCalledWith(expect.anything(), "MANAGE_SYSTEM", { limit: 30, windowMs: 60_000 });
  });

  it("accepts a MANAGE_SYSTEM authorization and returns evidence", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect((await response.json()).evidence.metadata.observability_status).toBe("PASS");
  });

  it("rejects CRON_SECRET alone", async () => {
    authorizeMock.mockResolvedValue({ ok: false, response: Response.json({ error: "AUTHENTICATION_REQUIRED" }, { status: 401 }) });
    const response = await GET(request("GET", undefined, "Bearer cron-secret-value"));
    expect(response.status).toBe(401);
    expect(authorizeMock).toHaveBeenCalledWith(expect.anything(), "MANAGE_SYSTEM", expect.anything());
    expect(collectMock).not.toHaveBeenCalled();
  });

  it("does not accept an optional machine token; access remains MANAGE_SYSTEM-only", async () => {
    authorizeMock.mockResolvedValue({ ok: false, response: Response.json({ error: "AUTHENTICATION_REQUIRED" }, { status: 401 }) });
    expect((await GET(request("GET", undefined, "Bearer machine-read-token"))).status).toBe(401);
    expect(collectMock).not.toHaveBeenCalled();
  });

  it.each([["POST", POST], ["PUT", PUT], ["PATCH", PATCH], ["DELETE", DELETE]] as const)("rejects %s", async (method, handler) => {
    const response = await handler(request(method));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(collectMock).not.toHaveBeenCalled();
  });

  it("passes the requested ISO checkpoint exactly after normalization", async () => {
    const response = await GET(request("GET", "https://opspilot.test/api/internal/observability/checkpoint?checkpointAt=2026-09-26T08%3A00%3A00%2B07%3A00"));
    expect(response.status).toBe(200);
    expect(collectMock).toHaveBeenCalledWith(CHECKPOINT);
  });

  it("rejects timestamps without a timezone", async () => {
    const response = await GET(request("GET", "https://opspilot.test/api/internal/observability/checkpoint?checkpointAt=2026-09-26T08%3A00%3A00"));
    expect(response.status).toBe(400);
    expect(collectMock).not.toHaveBeenCalled();
  });
});

describe("checkpoint evidence collector", () => {
  it("returns the sync run and exact requested checkpoint", async () => {
    const { client } = evidenceClient();
    const evidence = await collectReal(CHECKPOINT, client, FIXED_NOW);
    expect(evidence.sync.sync_run_id).toBe("run-08h-001");
    expect(evidence.sync.sync_status).toBe("success");
    expect(evidence.sync.completed_phases).toEqual(["FETCHING_SNAPSHOT", "PERSISTING_SNAPSHOTS", "COMPLETED"]);
    expect(evidence.metadata.requested_checkpoint_at).toBe(CHECKPOINT);
  });

  it("keeps an absent sync run NOT_FOUND instead of treating it as FAILED", async () => {
    const { client } = evidenceClient({ sync_runs: [], runningCount: 0 });
    const evidence = await collectReal(CHECKPOINT, client, FIXED_NOW);
    expect(evidence.sync.state).toBe("NOT_FOUND");
    expect(evidence.sync.sync_status).toBeNull();
    expect(evidence.sync.last_confirmed_phase).toBeNull();
  });

  it("returns a live running count and active lock without a linked run id", async () => {
    const { client } = evidenceClient();
    const evidence = await collectReal(CHECKPOINT, client, FIXED_NOW);
    expect(evidence.concurrency.current_running_count).toBe(1);
    expect(evidence.concurrency.active_sync_lock).toBe(true);
    expect(evidence.concurrency.lock_owner).toBe("owner_20260926");
    expect(evidence.concurrency.lock_run_id_status).toBe("NOT_LINKED_IN_CURRENT_SCHEMA");
  });

  it("matches cron by its canonical job name and returns execution history", async () => {
    const { client, queryLog } = evidenceClient();
    const evidence = await collectReal(CHECKPOINT, client, FIXED_NOW);
    expect(evidence.cron.cron_job_name).toBe("opspilot-followup-cycle-mb3");
    expect(evidence.cron.cron_job_id).toBe(14);
    expect(evidence.cron.cron_status).toBe("succeeded");
    expect(evidence.cron.cron_execution_found).toBe(true);
    expect(queryLog.find((query) => query.method === "rpc")?.table).toBe("rpc:opspilot_checkpoint_cron_evidence");
  });

  it("keeps missing cron history NOT_FOUND/UNKNOWN instead of FAILED", async () => {
    const { client } = evidenceClient({ cron: { job_found: true, job: { job_id: 14, job_name: "opspilot-followup-cycle-mb3", schedule: "0 1 * * *", active: true }, runs: [] } });
    const evidence = await collectReal(CHECKPOINT, client, FIXED_NOW);
    expect(evidence.cron.cron_execution_state).toBe("NOT_FOUND");
    expect(evidence.cron.cron_status).toBe("UNKNOWN");
  });

  it("returns checkpoint audit fields and dispatch metrics", async () => {
    const { client } = evidenceClient();
    const evidence = await collectReal(CHECKPOINT, client, FIXED_NOW);
    expect(evidence.checkpoint_audit.checkpoint_audit_status).toBe("SUCCESS");
    expect(evidence.checkpoint_audit.http_status).toBe(200);
    expect(evidence.dispatch.first_push_count).toBe(1);
    expect(evidence.dispatch.second_push_count).toBe(2);
    expect(evidence.dispatch.resolved_count).toBe(1);
  });

  it("keeps a missing checkpoint audit UNKNOWN instead of treating it as FAILED", async () => {
    const { client } = evidenceClient({ checkpoint_dispatch_audits: null });
    const evidence = await collectReal(CHECKPOINT, client, FIXED_NOW);
    expect(evidence.checkpoint_audit.checkpoint_audit_found).toBe(false);
    expect(evidence.checkpoint_audit.checkpoint_audit_status).toBe("UNKNOWN");
    expect(evidence.dispatch.dispatcher_status).toBe("UNKNOWN");
  });

  it("reports generation counts and explicitly surfaces unsupported duplicate generation", async () => {
    const { client } = evidenceClient();
    const evidence = await collectReal(CHECKPOINT, client, FIXED_NOW);
    expect(evidence.generation.generation_status).toBe("COMPLETE");
    expect(evidence.generation.manifest_count).toBe(1);
    expect(evidence.generation.expected_member_count).toBe(2);
    expect(evidence.generation.actual_member_count).toBe(2);
    expect(evidence.generation.duplicate_generation_count).toBeNull();
    expect(evidence.generation.duplicate_generation_status).toBe("NOT_IMPLEMENTED_IN_CURRENT_ARCHITECTURE");
  });

  it("reports multiple sync runs without silently selecting one", async () => {
    const baseRuns = evidenceClient().rows.sync_runs as any[];
    const run2 = { ...baseRuns[0], id: "run-08h-002", started_at: "2026-09-26T01:01:00.000Z" };
    const { client } = evidenceClient({ sync_runs: [baseRuns[0], run2] });
    const evidence = await collectReal(CHECKPOINT, client, FIXED_NOW);
    expect(evidence.sync.sync_status).toBe("MULTIPLE");
    expect(evidence.sync.sync_run_id).toBeNull();
    expect(evidence.sync.sync_run_count).toBe(2);
    expect(evidence.sync.duplicate_sync_run_count).toBe(1);
  });

  it("returns Telegram delivery counts without exposing message ids or content", async () => {
    const { client } = evidenceClient();
    const evidence = await collectReal(CHECKPOINT, client, FIXED_NOW);
    const serialized = JSON.stringify(evidence);
    expect(evidence.telegram.telegram_success_count).toBe(1);
    expect(evidence.telegram.telegram_failure_count).toBe(1);
    expect(serialized).not.toContain("1087968824");
    expect(serialized).not.toContain("status-id");
  });

  it("redacts credentials and PII from safe free-form errors", async () => {
    const source = "Bearer abc.def api_key=sekrit recipient=Nguyen Van A phone=0912345678 email=person@example.com parcel=12345678";
    const baseRun = (evidenceClient().rows.sync_runs as any[])[0];
    const { client } = evidenceClient({ sync_runs: [{ ...baseRun, error_message: source }] });
    const evidence = await collectReal(CHECKPOINT, client, FIXED_NOW);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("abc.def");
    expect(serialized).not.toContain("sekrit");
    expect(serialized).not.toContain("Nguyen Van A");
    expect(serialized).not.toContain("0912345678");
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("12345678");
  });

  it("redacts message text directly", () => {
    expect(redactReal("Authorization: Bearer abc.def phone=0912345678")).not.toContain("abc.def");
  });

  it("marks failed evidence reads PARTIAL without calling checkpoint status FAILED", async () => {
    const { client } = evidenceClient({ cronError: true });
    const evidence = await collectReal(CHECKPOINT, client, FIXED_NOW);
    expect(evidence.metadata.observability_status).toBe("PARTIAL");
    expect(evidence.cron.cron_execution_state).toBe("UNKNOWN");
    expect(evidence.source_errors).toContainEqual({ source: "cron.job+cron.job_run_details", error_code: "42501" });
  });

  it("marks all evidence unavailable as BLOCKED", async () => {
    const badClient: any = {
      from: () => ({
        select() { return this; }, eq() { return this; }, in() { return this; }, contains() { return this; }, order() { return this; }, limit() { return this; }, gte() { return this; }, lte() { return this; },
        maybeSingle: async () => ({ data: null, error: { code: "XX000" } }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: { code: "XX000" }, count: null }).then(resolve),
      }),
      rpc: async () => ({ data: null, error: { code: "XX000" } }),
    };
    const evidence = await collectReal(CHECKPOINT, badClient, FIXED_NOW);
    expect(evidence.metadata.observability_status).toBe("BLOCKED");
    expect(evidence.sync.state).toBe("UNKNOWN");
  });

  it("uses only read methods and the fixed-scope cron evidence RPC", async () => {
    const { client, queryLog } = evidenceClient();
    await collectReal(CHECKPOINT, client, FIXED_NOW);
    expect(queryLog.some((query) => ["insert", "update", "delete", "upsert"].includes(query.method))).toBe(false);
    expect(client.rpc).toHaveBeenCalledWith("opspilot_checkpoint_cron_evidence", { p_checkpoint_at: CHECKPOINT });
  });

  it("keeps writer services out of the collector and constrains the cron function", () => {
    const serviceSource = readFileSync("src/services/checkpoint-observability.ts", "utf8");
    const sqlSource = readFileSync("src/database/migrations/093_checkpoint_observability_cron_read.sql", "utf8");
    const routeSource = readFileSync("src/app/api/internal/observability/checkpoint/route.ts", "utf8");
    expect(serviceSource).not.toMatch(/SyncService|runSync\(|dispatch[A-Z]|TelegramClient|\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    expect(routeSource).toMatch(/authorizeApiRequest\(request, "MANAGE_SYSTEM"/);
    expect(routeSource).not.toMatch(/isCronAuthorized|CRON_SECRET|OPS_OBSERVABILITY_READ_TOKEN/);
    expect(sqlSource).toMatch(/LANGUAGE SQL[\s\S]*?STABLE[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = ''/);
    expect(sqlSource).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*?FROM PUBLIC, anon, authenticated/);
    expect(sqlSource).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role/);
    expect(sqlSource).not.toMatch(/EXECUTE\s+IMMEDIATE|cron\.(schedule|unschedule)\s*\(/i);
    expect(sqlSource).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
  });

  it("reports publication pointers as not implemented in the current architecture", async () => {
    const { client } = evidenceClient();
    const evidence = await collectReal(CHECKPOINT, client, FIXED_NOW);
    expect(evidence.publication.checkpoint_pointer_status).toBe("NOT_IMPLEMENTED_IN_CURRENT_ARCHITECTURE");
    expect(evidence.publication.manifest_pointer_status).toBe("NOT_IMPLEMENTED_IN_CURRENT_ARCHITECTURE");
  });
});
