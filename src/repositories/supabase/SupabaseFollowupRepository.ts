import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import type { FollowupCaseRow, FollowupEventRow } from "@/connectors/supabase/types";
import {
  FOLLOWUP_COHORT_HARD_LIMIT_BYTES,
  FOLLOWUP_MEMBER_MAX_ROWS,
  assertFollowupMemberGenerationParity,
  operationalCohortMemberRows,
  operationalCohortV2Metadata,
  planFollowupMemberWriteChunks,
  type FollowupCaseMemberRow,
} from "@/domain/operational-learning/normalized-followup-members";
import type { OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";
import { logRuntimeError } from "@/observability/runtimeDiagnostics";
import { BaseRepository } from "../base/BaseRepository";
import type {
  FollowupCaseUpsert,
  FollowupCaseLinkRow,
  FollowupEventInsert,
  FollowupEventEvidence,
  IFollowupRepository,
  FollowupCasePageCursor,
  FollowupCohortGenerationOptions,
  FollowupCaseCohortReference,
} from "../interfaces/IFollowupRepository";
import { hydrateFollowupCaseRows } from "./followup-case-cohort";

export const MANIFEST_VERIFY_BATCH_SIZE = 100;

export interface FollowupPersistenceDiagnosticParams {
  operation: "manifest_verify" | "member_upsert";
  table: string;
  generationId: string;
  batchIndex?: number;
  batchCount?: number;
  caseCount?: number;
  chunkIndex?: number;
  rowCount?: number;
  serializedBytes?: number;
  status?: number | string | null;
  code?: string | null;
  message: string;
  details?: string | null;
  hint?: string | null;
}

export class FollowupPersistenceError extends Error {
  readonly operation: "manifest_verify" | "member_upsert";
  readonly table: string;
  readonly generationId: string;
  readonly batchIndex?: number;
  readonly batchCount?: number;
  readonly caseCount?: number;
  readonly chunkIndex?: number;
  readonly rowCount?: number;
  readonly serializedBytes?: number;
  readonly status: number | string | null;
  readonly code: string | null;
  readonly details: string | null;
  readonly hint: string | null;

  constructor(diagnostics: FollowupPersistenceDiagnosticParams, cause?: unknown) {
    const parts: string[] = [
      `operation=${diagnostics.operation}`,
      `table=${diagnostics.table}`,
      `generationId=${diagnostics.generationId}`,
    ];
    if (diagnostics.batchIndex !== undefined) parts.push(`batchIndex=${diagnostics.batchIndex}`);
    if (diagnostics.batchCount !== undefined) parts.push(`batchCount=${diagnostics.batchCount}`);
    if (diagnostics.caseCount !== undefined) parts.push(`caseCount=${diagnostics.caseCount}`);
    if (diagnostics.chunkIndex !== undefined) parts.push(`chunkIndex=${diagnostics.chunkIndex}`);
    if (diagnostics.rowCount !== undefined) parts.push(`rowCount=${diagnostics.rowCount}`);
    if (diagnostics.serializedBytes !== undefined) parts.push(`serializedBytes=${diagnostics.serializedBytes}`);
    if (diagnostics.status !== undefined && diagnostics.status !== null) parts.push(`status=${diagnostics.status}`);
    if (diagnostics.code) parts.push(`code=${diagnostics.code}`);
    parts.push(`message=${diagnostics.message}`);
    if (diagnostics.details) parts.push(`details=${diagnostics.details}`);
    if (diagnostics.hint) parts.push(`hint=${diagnostics.hint}`);

    super(`FOLLOWUP_PERSISTENCE_ERROR:${diagnostics.operation} [${parts.join(" ")}]`, { cause });
    this.name = "FollowupPersistenceError";
    this.operation = diagnostics.operation;
    this.table = diagnostics.table;
    this.generationId = diagnostics.generationId;
    this.batchIndex = diagnostics.batchIndex;
    this.batchCount = diagnostics.batchCount;
    this.caseCount = diagnostics.caseCount;
    this.chunkIndex = diagnostics.chunkIndex;
    this.rowCount = diagnostics.rowCount;
    this.serializedBytes = diagnostics.serializedBytes;
    this.status = diagnostics.status ?? null;
    this.code = diagnostics.code ?? null;
    this.details = diagnostics.details ?? null;
    this.hint = diagnostics.hint ?? null;
  }
}

function extractPostgrestDetails(error: unknown): {
  status: number | string | null;
  code: string | null;
  message: string;
  details: string | null;
  hint: string | null;
} {
  const src = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const status = typeof src.status === "number" || typeof src.status === "string" ? src.status : null;
  const code = typeof src.code === "string" ? src.code : null;
  const message = typeof src.message === "string" && src.message.length > 0
    ? src.message
    : (error instanceof Error ? error.message : "Unknown database error");
  const details = typeof src.details === "string" ? src.details : null;
  const hint = typeof src.hint === "string" ? src.hint : null;
  return { status, code, message, details, hint };
}

const FOLLOWUP_CASE_COLUMNS = [
  "operational_cohort",
  "cohort_version",
  "member_generation_id",
  "id",
  "incident_id",
  "incident_key",
  "current_state",
  "first_detected_at",
  "last_checked_at",
  "next_action_at",
  "last_action_requested_at",
  "last_action_confirmed_at",
  "resolved_at",
  "closed_at",
  "baseline_affected_order_count",
  "latest_affected_order_count",
  "current_progress_percent",
  "current_assessment",
  "current_rillnet_status_signature",
  "last_action_rillnet_status_signature",
  "rillnet_change_summary",
  "rillnet_changed_at",
  "rillnet_review_before_signature",
  "rillnet_review_after_signature",
  "rillnet_review_detected_at",
  "rillnet_review_snapshot_id",
  "rillnet_review_order_codes",
  "created_at",
  "updated_at",
].join(", ");
const FOLLOWUP_CASE_SUMMARY_COLUMNS = FOLLOWUP_CASE_COLUMNS
  .split(", ")
  .filter((column) => !["operational_cohort", "cohort_version", "member_generation_id"].includes(column))
  .join(", ");

const FOLLOWUP_EVENT_COLUMNS = [
  "id",
  "followup_case_id",
  "event_type",
  "event_time",
  "snapshot_id",
  "old_state",
  "new_state",
  "assessment",
  "confirmed_by",
  "notes",
  "created_at",
].join(", ");

const FOLLOWUP_CASE_PAGE_SIZE = 100;
const FOLLOWUP_EVIDENCE_BATCH_SIZE = 100;
const FOLLOWUP_CASE_IDENTITY_BATCH_SIZE = 100;
const FOLLOWUP_CASE_LINK_COLUMNS = ["id", "incident_id", "incident_key"].join(", ");
const FOLLOWUP_MEMBER_COLUMNS = [
  "followup_case_id", "generation_id", "source_sync_run_id", "order_code", "customer_id",
  "warehouse_id", "stage", "status", "observed_at", "ready_at", "source", "baseline_status",
  "is_baseline", "due_at", "last_reminder_at", "last_reminder_status", "completed_at",
  "member_active", "verification_failure",
].join(",");
const FOLLOWUP_MEMBER_VERIFY_PAGE_SIZE = FOLLOWUP_MEMBER_MAX_ROWS;
const FOLLOWUP_PROCESSING_CASE_COLUMNS = [
  "operational_cohort",
  "cohort_version",
  "member_generation_id",
  "id",
  "incident_id",
  "incident_key",
  "current_state",
  "first_detected_at",
  "last_checked_at",
  "last_action_requested_at",
  "last_action_confirmed_at",
  "resolved_at",
  "baseline_affected_order_count",
  "latest_affected_order_count",
  "current_progress_percent",
  "current_assessment",
  "current_rillnet_status_signature",
  "updated_at",
].join(", ");

export class SupabaseFollowupRepository extends BaseRepository implements IFollowupRepository {
  constructor(client: SupabaseClient) {
    super(client);
  }

  private async readCaseIdentities(
    column: "id" | "incident_id" | "incident_key",
    values: string[],
  ): Promise<FollowupCaseLinkRow[]> {
    const uniqueValues = [...new Set(values.filter(Boolean))];
    const rows: FollowupCaseLinkRow[] = [];
    for (let start = 0; start < uniqueValues.length; start += FOLLOWUP_CASE_IDENTITY_BATCH_SIZE) {
      const batch = uniqueValues.slice(start, start + FOLLOWUP_CASE_IDENTITY_BATCH_SIZE);
      const query = this.client
        .from("followup_cases")
        .select(FOLLOWUP_CASE_LINK_COLUMNS)
        .in(column, batch);
      rows.push(...await this.executeMany<FollowupCaseLinkRow>(query as unknown as Promise<{
        data: FollowupCaseLinkRow[] | null;
        error: unknown;
      }>));
    }
    return rows;
  }

  /**
   * Fail closed on ambiguous case identity before any generation, archive,
   * member, or parent-pointer write. incident_key is the stable business key;
   * incident_id may change when the source incident is refreshed, but it may
   * never already belong to another stable key.
   */
  private async assertCaseIdentityBatch(cases: FollowupCaseUpsert[]): Promise<void> {
    const incomingByKey = new Map<string, FollowupCaseUpsert>();
    const incomingByIncidentId = new Map<string, FollowupCaseUpsert>();
    for (const caseData of cases) {
      if (incomingByKey.has(caseData.incident_key)) {
        throw new Error(`FOLLOWUP_CASE_DUPLICATE_INCOMING_KEY:${caseData.incident_key}`);
      }
      incomingByKey.set(caseData.incident_key, caseData);
      const incidentOwner = incomingByIncidentId.get(caseData.incident_id);
      if (incidentOwner) {
        throw new Error(`FOLLOWUP_CASE_DUPLICATE_INCOMING_INCIDENT_ID:${caseData.incident_id}`);
      }
      incomingByIncidentId.set(caseData.incident_id, caseData);
    }

    const [keyRows, incidentRows] = await Promise.all([
      this.readCaseIdentities("incident_key", [...incomingByKey.keys()]),
      this.readCaseIdentities("incident_id", [...incomingByIncidentId.keys()]),
    ]);
    const indexRows = (rows: FollowupCaseLinkRow[], identity: keyof FollowupCaseLinkRow, label: string) => {
      const indexed = new Map<string, FollowupCaseLinkRow>();
      for (const row of rows) {
        const value = row[identity];
        const previous = indexed.get(value);
        if (previous && previous.id !== row.id) {
          throw new Error(`FOLLOWUP_CASE_EXISTING_IDENTITY_AMBIGUOUS:${label}`);
        }
        indexed.set(value, row);
      }
      return indexed;
    };
    const existingByKey = indexRows(keyRows, "incident_key", "incident_key");
    const existingByIncidentId = indexRows(incidentRows, "incident_id", "incident_id");

    for (const caseData of cases) {
      const keyOwner = existingByKey.get(caseData.incident_key);
      const incidentOwner = existingByIncidentId.get(caseData.incident_id);

      if (keyOwner && (!caseData.id || keyOwner.id !== caseData.id)) {
        throw new Error(`FOLLOWUP_CASE_STABLE_KEY_MUST_REUSE_EXISTING_ID:${caseData.incident_key}`);
      }
      if (caseData.id && !keyOwner) {
        throw new Error(`FOLLOWUP_CASE_STABLE_KEY_LOOKUP_MISMATCH:${caseData.incident_key}`);
      }
      if (incidentOwner && incidentOwner.incident_key !== caseData.incident_key) {
        throw new Error(`FOLLOWUP_CASE_INCIDENT_ID_OWNED_BY_DIFFERENT_KEY:${caseData.incident_id}`);
      }
    }
  }

  async getCaseById(id: string): Promise<FollowupCaseRow | null> {
    const query = this.client
      .from("followup_cases")
      .select("*")
      .or(`id.eq.${id},incident_key.eq.${id}`)
      .maybeSingle();

    const followupCase = await this.executeOptional<FollowupCaseRow>(query as any);
    if (!followupCase) return null;
    return (await hydrateFollowupCaseRows(this.client, [followupCase]))[0];
  }

  async hydrateFollowupCaseCohorts<T extends FollowupCaseCohortReference>(cases: T[]) {
    return hydrateFollowupCaseRows(this.client, cases);
  }

  async getCasesByIncidentKeys(incidentKeys: string[]): Promise<FollowupCaseRow[]> {
    if (incidentKeys.length === 0) return [];

    const query = this.client
      .from("followup_cases")
      .select(FOLLOWUP_CASE_COLUMNS)
      .in("incident_key", incidentKeys);

    const cases = await this.executeMany<FollowupCaseRow>(query as unknown as Promise<{ data: FollowupCaseRow[] | null; error: unknown }>);
    return hydrateFollowupCaseRows(this.client, cases);
  }

  async getOperationalCasesPage(cursor?: FollowupCasePageCursor, limit: number = FOLLOWUP_CASE_PAGE_SIZE): Promise<{
    cases: FollowupCaseRow[];
    nextCursor: FollowupCasePageCursor | null;
  }> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || FOLLOWUP_CASE_PAGE_SIZE, 1), FOLLOWUP_CASE_PAGE_SIZE);
    const query = this.client
      .from("followup_cases")
      .select(FOLLOWUP_PROCESSING_CASE_COLUMNS)
      .neq("current_state", "CLOSED");

    if (cursor) {
      query.or(`updated_at.lt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.lt.${cursor.id})`);
    }
    query
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(boundedLimit);

    const cases = await this.executeMany<FollowupCaseRow>(
      query as unknown as Promise<{ data: FollowupCaseRow[] | null; error: unknown }>
    );
    const last = cases[cases.length - 1];

    return {
      cases: await hydrateFollowupCaseRows(this.client, cases),
      nextCursor: cases.length === boundedLimit && last?.updated_at
        ? { updatedAt: last.updated_at, id: last.id }
        : null,
    };
  }

  private async readAllCases(columns: string): Promise<FollowupCaseRow[]> {
    const cases: FollowupCaseRow[] = [];
    let cursor: FollowupCasePageCursor | undefined;

    // Keep terminal cases included and bound every parent page.
    for (;;) {
      const query = this.client
        .from("followup_cases")
        .select(columns);

      if (cursor) {
        query.or(`updated_at.lt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.lt.${cursor.id})`);
      }
      query
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(FOLLOWUP_CASE_PAGE_SIZE);

      const page = await this.executeMany<FollowupCaseRow>(
        query as unknown as Promise<{ data: FollowupCaseRow[] | null; error: unknown }>
      );
      cases.push(...page);

      if (page.length < FOLLOWUP_CASE_PAGE_SIZE) break;
      const last = page[page.length - 1];
      if (!last?.updated_at || !last.id) break;
      cursor = { updatedAt: last.updated_at, id: last.id };
    }

    return cases;
  }

  async getAllCasesSummary(): Promise<FollowupCaseRow[]> {
    // The dashboard renders parent-level fields only; it does not need each
    // normalized order-level cohort hydrated.
    return this.readAllCases(FOLLOWUP_CASE_SUMMARY_COLUMNS);
  }

  async getAllCases(): Promise<FollowupCaseRow[]> {
    return hydrateFollowupCaseRows(this.client, await this.readAllCases(FOLLOWUP_CASE_COLUMNS));
  }

  async upsertCase(caseData: FollowupCaseUpsert): Promise<FollowupCaseRow> {
    const now = new Date().toISOString();
    const payload = {
      ...caseData,
      updated_at: now,
    };

    const query = this.client
      .from("followup_cases")
      .upsert(payload, { onConflict: "incident_key" })
      .select()
      .single();

    return this.executeSingle<FollowupCaseRow>(query as any);
  }

  async batchUpsertCases(cases: FollowupCaseUpsert[]): Promise<FollowupCaseLinkRow[]> {
    if (cases.length === 0) return [];

    const now = new Date().toISOString();
    const payload = cases.map((caseData) => ({
      ...caseData,
      updated_at: now,
    }));

    const query = this.client
      .from("followup_cases")
      .upsert(payload, { onConflict: "incident_key" })
      .select(FOLLOWUP_CASE_LINK_COLUMNS);

    return this.executeMany<FollowupCaseLinkRow>(query as unknown as Promise<{ data: FollowupCaseLinkRow[] | null; error: unknown }>);
  }

  async persistOperationalCohortGenerations(
    cases: FollowupCaseUpsert[],
    generationId: string,
    options: FollowupCohortGenerationOptions = {},
  ): Promise<FollowupCaseLinkRow[]> {
    if (!cases.length) return [];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generationId)) {
      throw new Error("FOLLOWUP_MEMBER_GENERATION_ID_MUST_BE_SYNC_RUN_UUID");
    }

    const metadataByIncident = new Map<string, ReturnType<typeof operationalCohortV2Metadata>>();
    for (const caseData of cases) {
      const cohort = caseData.operational_cohort as OperationalCohort | null | undefined;
      if (!cohort || cohort.version !== 1 || !Array.isArray(cohort.members) || !Array.isArray(cohort.baselineCodes)) {
        throw new Error(`FOLLOWUP_COHORT_V1_INPUT_REQUIRED:${caseData.incident_key}`);
      }
      const metadata = operationalCohortV2Metadata(cohort);
      const bytes = new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
      if (bytes > FOLLOWUP_COHORT_HARD_LIMIT_BYTES) {
        throw new Error(`FOLLOWUP_COHORT_V2_METADATA_EXCEEDS_HARD_LIMIT:${caseData.incident_key}:${bytes}`);
      }
      metadataByIncident.set(caseData.incident_key, metadata);
    }

    await this.assertCaseIdentityBatch(cases);

    const parentByIncident = new Map<string, { id: string; updated_at: string }>();
    const newCases = cases.filter((caseData) => !caseData.id);
    if (newCases.length) {
      const now = new Date().toISOString();
      const seeds = newCases.map((caseData) => {
        return {
          // Keep a new case invisible to V2 readers until its complete member
          // generation is verified and the final pointer/state update commits.
          incident_id: caseData.incident_id,
          incident_key: caseData.incident_key,
          current_state: "NEW",
          first_detected_at: caseData.first_detected_at,
          operational_cohort: null,
          cohort_version: null,
          member_generation_id: null,
          updated_at: now,
        };
      });
      const inserted = await this.executeMany<FollowupCaseRow>(
        (this.client.from("followup_cases") as any)
          .insert(seeds)
          .select(FOLLOWUP_CASE_COLUMNS) as unknown as Promise<{ data: FollowupCaseRow[] | null; error: unknown }>
      );
      for (const row of inserted) {
        if (!row.updated_at) throw new Error(`FOLLOWUP_MEMBER_PARENT_INSERT_MISSING_UPDATED_AT:${row.incident_key}`);
        parentByIncident.set(row.incident_key, { id: row.id, updated_at: row.updated_at });
      }
    }

    for (const caseData of cases) {
      if (caseData.id) {
        if (!caseData.updated_at) throw new Error(`FOLLOWUP_MEMBER_PARENT_VERSION_MISSING:${caseData.incident_key}`);
        parentByIncident.set(caseData.incident_key, { id: caseData.id, updated_at: caseData.updated_at });
      }
    }

    const archiveCandidates = options.archiveLegacy === false
      ? []
      : cases.filter((caseData) => caseData.cohort_version !== 2);
    for (const caseData of archiveCandidates) {
      const cohort = caseData.operational_cohort as OperationalCohort;
      const parent = parentByIncident.get(caseData.incident_key);
      if (!parent) throw new Error(`FOLLOWUP_COHORT_ARCHIVE_PARENT_MISSING:${caseData.incident_key}`);
      const sourceUpdatedAt = caseData.id ? caseData.updated_at : parent.updated_at;
      if (!sourceUpdatedAt) throw new Error(`FOLLOWUP_COHORT_ARCHIVE_SOURCE_VERSION_MISSING:${caseData.incident_key}`);
      const serialized = JSON.stringify(cohort);
      const { error } = await (this.client.from("followup_case_cohort_archive") as any)
        .upsert({
          followup_case_id: parent.id,
          original_operational_cohort: cohort,
          source_case_updated_at: sourceUpdatedAt,
          source_cohort_sha256: createHash("sha256").update(serialized).digest("hex"),
        }, { onConflict: "followup_case_id", ignoreDuplicates: true });
      if (error) throw error;
    }

    const unresolved = cases.filter((caseData) => !parentByIncident.has(caseData.incident_key));
    if (unresolved.length) throw new Error(`FOLLOWUP_MEMBER_PARENT_RESOLUTION_FAILED:${unresolved.map((row) => row.incident_key).join(",")}`);

    const expectedByCaseId = new Map<string, FollowupCaseMemberRow[]>();
    const allExpected: FollowupCaseMemberRow[] = [];
    for (const caseData of cases) {
      const parent = parentByIncident.get(caseData.incident_key)!;
      const cohort = caseData.operational_cohort as OperationalCohort;
      const sourceSyncRunId = options.sourceSyncRunId === undefined ? generationId : options.sourceSyncRunId;
      const rows = operationalCohortMemberRows(parent.id, generationId, sourceSyncRunId, cohort);
      expectedByCaseId.set(parent.id, rows);
      allExpected.push(...rows);
    }

    const generationRecords = [...expectedByCaseId.entries()].map(([followupCaseId, rows]) => ({
      followup_case_id: followupCaseId,
      generation_id: generationId,
      source_sync_run_id: options.sourceSyncRunId === undefined ? generationId : options.sourceSyncRunId,
      expected_member_count: rows.length,
      generation_status: "PREPARING",
      committed_at: null,
    }));
    const { error: generationRegisterError } = await (this.client.from("followup_case_member_generations") as any)
      .upsert(generationRecords, {
        onConflict: "followup_case_id,generation_id",
        ignoreDuplicates: true,
      });
    if (generationRegisterError) throw generationRegisterError;
    const generationCaseIds = generationRecords.map((record) => record.followup_case_id);
    const storedGenerationRecords: Array<{
      followup_case_id: string;
      generation_id: string;
      source_sync_run_id: string | null;
      expected_member_count: number;
      generation_status: string;
    }> = [];
    const verifyBatchCount = Math.ceil(generationCaseIds.length / MANIFEST_VERIFY_BATCH_SIZE);

    for (let batchIndex = 0; batchIndex < verifyBatchCount; batchIndex++) {
      const start = batchIndex * MANIFEST_VERIFY_BATCH_SIZE;
      const batch = generationCaseIds.slice(start, start + MANIFEST_VERIFY_BATCH_SIZE);
      let pageRecords: any[] | null = null;
      let generationReadError: any = null;
      try {
        const result = await (this.client.from("followup_case_member_generations") as any)
          .select("followup_case_id,generation_id,source_sync_run_id,expected_member_count,generation_status")
          .eq("generation_id", generationId)
          .in("followup_case_id", batch);
        pageRecords = result.data;
        generationReadError = result.error;
      } catch (err: any) {
        generationReadError = err;
      }

      if (generationReadError) {
        const postgrest = extractPostgrestDetails(generationReadError);
        const diagError = new FollowupPersistenceError({
          operation: "manifest_verify",
          table: "followup_case_member_generations",
          generationId,
          batchIndex,
          batchCount: verifyBatchCount,
          caseCount: batch.length,
          status: postgrest.status,
          code: postgrest.code,
          message: postgrest.message,
          details: postgrest.details,
          hint: postgrest.hint,
        }, generationReadError);
        logRuntimeError("SupabaseFollowupRepository.manifest_verify", diagError);
        throw diagError;
      }

      if (pageRecords) {
        storedGenerationRecords.push(...pageRecords);
      }
    }

    const storedByCase = new Map((storedGenerationRecords || []).map((record: any) => [record.followup_case_id, record]));
    for (const expected of generationRecords) {
      const stored = storedByCase.get(expected.followup_case_id) as any;
      if (!stored
        || stored.generation_id !== generationId
        || stored.source_sync_run_id !== expected.source_sync_run_id
        || stored.expected_member_count !== expected.expected_member_count) {
        throw new Error(`FOLLOWUP_MEMBER_GENERATION_MANIFEST_MISMATCH:${expected.followup_case_id}`);
      }
    }

    const actualByCaseId = new Map<string, FollowupCaseMemberRow[]>();
    const readGenerationRows = async (caseIds: string[]) => {
      for (let start = 0; start < caseIds.length; start += 100) {
        const idBatch = caseIds.slice(start, start + 100);
        let offset = 0;
        for (;;) {
          const { data, error } = await (this.client.from("followup_case_members") as any)
            .select(FOLLOWUP_MEMBER_COLUMNS)
            .eq("generation_id", generationId)
            .in("followup_case_id", idBatch)
            .order("followup_case_id", { ascending: true })
            .order("order_code", { ascending: true })
            .range(offset, offset + FOLLOWUP_MEMBER_VERIFY_PAGE_SIZE - 1);
          if (error) throw error;
          const page = (data || []) as FollowupCaseMemberRow[];
          for (const row of page) {
            const rows = actualByCaseId.get(row.followup_case_id) || [];
            rows.push(row);
            actualByCaseId.set(row.followup_case_id, rows);
          }
          if (page.length < FOLLOWUP_MEMBER_VERIFY_PAGE_SIZE) break;
          offset += FOLLOWUP_MEMBER_VERIFY_PAGE_SIZE;
        }
      }
    };

    const committedCaseIds = new Set(cases.flatMap((caseData) => {
      const parent = parentByIncident.get(caseData.incident_key)!;
      return caseData.cohort_version === 2 && caseData.member_generation_id === generationId ? [parent.id] : [];
    }));
    // A pointer already naming this run means its generation was committed.
    // Verify it and never mutate its rows in place on a retry.
    await readGenerationRows([...committedCaseIds]);
    for (const caseId of committedCaseIds) {
      assertFollowupMemberGenerationParity(expectedByCaseId.get(caseId) || [], actualByCaseId.get(caseId) || []);
    }

    const pendingWrites = allExpected.filter((row) => !committedCaseIds.has(row.followup_case_id));
    const chunks = planFollowupMemberWriteChunks(pendingWrites);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      let upsertError: any = null;
      try {
        const result = await (this.client.from("followup_case_members") as any)
          .upsert(chunk, { onConflict: "followup_case_id,generation_id,order_code" });
        upsertError = result.error;
      } catch (err: any) {
        upsertError = err;
      }
      if (upsertError) {
        const postgrest = extractPostgrestDetails(upsertError);
        const diagError = new FollowupPersistenceError({
          operation: "member_upsert",
          table: "followup_case_members",
          generationId,
          chunkIndex,
          rowCount: chunk.length,
          serializedBytes: Buffer.byteLength(JSON.stringify(chunk), "utf8"),
          status: postgrest.status,
          code: postgrest.code,
          message: postgrest.message,
          details: postgrest.details,
          hint: postgrest.hint,
        }, upsertError);
        logRuntimeError("SupabaseFollowupRepository.member_upsert", diagError);
        throw diagError;
      }
    }

    const pendingCaseIds = [...expectedByCaseId.keys()].filter((caseId) => !committedCaseIds.has(caseId));
    await readGenerationRows(pendingCaseIds);
    for (const [caseId, expected] of expectedByCaseId) {
      assertFollowupMemberGenerationParity(expected, actualByCaseId.get(caseId) || []);
    }

    const finalized: FollowupCaseLinkRow[] = cases.flatMap((caseData) => {
      const parent = parentByIncident.get(caseData.incident_key)!;
      return committedCaseIds.has(parent.id)
        ? [{ id: parent.id, incident_id: caseData.incident_id, incident_key: caseData.incident_key }]
        : [];
    });
    const finalizeInputs = cases
      .map((caseData) => ({ caseData, parent: parentByIncident.get(caseData.incident_key)! }))
      .filter(({ parent }) => !committedCaseIds.has(parent.id));
    for (let start = 0; start < finalizeInputs.length; start += 10) {
      const batch = finalizeInputs.slice(start, start + 10);
      const results = await Promise.all(batch.map(async ({ caseData, parent }) => {
        const cohort = caseData.operational_cohort as OperationalCohort;
        const metadata = metadataByIncident.get(caseData.incident_key)!;
        const { id: _id, updated_at: _updatedAt, operational_cohort: _oldCohort,
          cohort_version: _oldVersion, member_generation_id: _oldGeneration, ...casePatch } = caseData as any;
        const update = (this.client.from("followup_cases") as any)
          .update({
            ...casePatch,
            operational_cohort: metadata,
            cohort_version: 2,
            member_generation_id: generationId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", parent.id)
          .eq("updated_at", parent.updated_at)
          .select(FOLLOWUP_CASE_LINK_COLUMNS)
          .maybeSingle();
        const { data, error } = await update;
        if (error) throw error;
        if (data) return data as FollowupCaseLinkRow;

        const { data: current, error: readError } = await (this.client.from("followup_cases") as any)
          .select("id,incident_id,incident_key,cohort_version,member_generation_id")
          .eq("id", parent.id)
          .maybeSingle();
        if (readError) throw readError;
        if (current?.cohort_version === 2 && current.member_generation_id === generationId) {
          return { id: current.id, incident_id: current.incident_id, incident_key: current.incident_key } as FollowupCaseLinkRow;
        }
        throw new Error(`FOLLOWUP_COHORT_PARENT_CONCURRENT_MODIFICATION:${caseData.incident_key}`);
      }));
      finalized.push(...results);
    }

    for (let start = 0; start < generationCaseIds.length; start += 100) {
      const caseIds = generationCaseIds.slice(start, start + 100);
      const { error } = await (this.client.from("followup_case_member_generations") as any)
        .update({ generation_status: "COMMITTED", committed_at: new Date().toISOString() })
        .eq("generation_id", generationId)
        .eq("generation_status", "PREPARING")
        .in("followup_case_id", caseIds)
        .select("followup_case_id");
      if (error) throw error;
      const { data: verified, error: verifyError } = await (this.client.from("followup_case_member_generations") as any)
        .select("followup_case_id,generation_status,committed_at")
        .eq("generation_id", generationId)
        .in("followup_case_id", caseIds);
      if (verifyError) throw verifyError;
      if ((verified || []).length !== caseIds.length
        || verified.some((record: any) => record.generation_status !== "COMMITTED" || !record.committed_at)) {
        throw new Error(`FOLLOWUP_MEMBER_GENERATION_COMMIT_MISMATCH:expected=${caseIds.length}:actual=${(verified || []).length}`);
      }
    }
    return finalized;
  }

  async insertEvent(eventData: FollowupEventInsert): Promise<FollowupEventRow> {
    const now = new Date().toISOString();
    const payload = {
      ...eventData,
      event_time: eventData.event_time || now,
      created_at: eventData.created_at || now,
    };

    const query = this.client
      .from("followup_events")
      .insert([payload])
      .select()
      .single();

    return this.executeSingle<FollowupEventRow>(query as any);
  }

  async batchInsertEvents(events: FollowupEventInsert[]): Promise<FollowupEventRow[]> {
    if (events.length === 0) return [];

    const now = new Date().toISOString();
    const payload = events.map((eventData) => ({
      ...eventData,
      event_time: eventData.event_time || now,
      created_at: eventData.created_at || now,
    }));

    const query = this.client
      .from("followup_events")
      .insert(payload)
      .select(FOLLOWUP_EVENT_COLUMNS);

    return this.executeMany<FollowupEventRow>(query as unknown as Promise<{ data: FollowupEventRow[] | null; error: unknown }>);
  }

  async getEventsByCaseId(followupCaseId: string): Promise<FollowupEventRow[]> {
    const query = this.client
      .from("followup_events")
      .select("*")
      .eq("followup_case_id", followupCaseId)
      .order("created_at", { ascending: false });

    return this.executeMany<FollowupEventRow>(query as unknown as Promise<{ data: FollowupEventRow[] | null; error: unknown }>);
  }

  async getEventsByCaseIds(followupCaseIds: string[]): Promise<FollowupEventEvidence[]> {
    const ids = Array.from(new Set(followupCaseIds.filter(Boolean)));
    if (ids.length === 0) return [];

    const rows: FollowupEventEvidence[] = [];
    for (let index = 0; index < ids.length; index += FOLLOWUP_EVIDENCE_BATCH_SIZE) {
      const chunk = ids.slice(index, index + FOLLOWUP_EVIDENCE_BATCH_SIZE);
      const query = this.client
        .from("followup_events")
        .select("followup_case_id,event_type,new_state")
        .in("followup_case_id", chunk)
        .or("event_type.eq.PUSH_CONFIRMED,new_state.eq.FIRST_PUSH_SENT");

      rows.push(...await this.executeMany<FollowupEventEvidence>(
        query as unknown as Promise<{ data: FollowupEventEvidence[] | null; error: unknown }>
      ));
    }
    return rows;
  }

  async getRecentEvents(limit: number = 30): Promise<FollowupEventRow[]> {
    const query = this.client
      .from("followup_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    return this.executeMany<FollowupEventRow>(query as unknown as Promise<{ data: FollowupEventRow[] | null; error: unknown }>);
  }
}
