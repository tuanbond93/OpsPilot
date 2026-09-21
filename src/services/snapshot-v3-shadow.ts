import type { OrderSnapshotRow } from "@/connectors/supabase/types";
import { isSnapshotV3ShadowEnabled } from "@/config/snapshot-v3";
import { compareSnapshotV3Cohort, type SnapshotV3Comparison } from "@/domain/snapshot-v3/comparator";
import type { ISnapshotV3ShadowRepository, SnapshotV3ShadowWriteResult } from "@/repositories/interfaces/ISnapshotV3ShadowRepository";

export type SnapshotV3ShadowRunResult = {
  legacyRows: number;
  shadowStatus: "DISABLED" | "NO_REPOSITORY" | "SUCCESS" | "FAILED";
  write?: SnapshotV3ShadowWriteResult;
  comparison?: SnapshotV3Comparison;
  error?: string;
};

export async function runSnapshotV3Shadow(params: {
  shadowRepository: ISnapshotV3ShadowRepository | null;
  syncRunId: string;
  rows: OrderSnapshotRow[];
  evaluationReferenceAt: string;
}): Promise<Omit<SnapshotV3ShadowRunResult, "legacyRows">> {
  if (!isSnapshotV3ShadowEnabled()) return { shadowStatus: "DISABLED" };
  if (!params.shadowRepository) {
    return { shadowStatus: "NO_REPOSITORY", error: "SNAPSHOT_V3_SHADOW_REPOSITORY_UNAVAILABLE" };
  }

  try {
    const write = await params.shadowRepository.writeBatch(
      params.syncRunId,
      params.rows,
      params.evaluationReferenceAt
    );
    const reconstructed = await params.shadowRepository.reconstructSyncRun(params.syncRunId);
    const comparison = compareSnapshotV3Cohort(params.rows, reconstructed);
    if (params.shadowRepository.recordComparison) {
      try {
        await params.shadowRepository.recordComparison(params.syncRunId, comparison);
      } catch (error) {
        return {
          shadowStatus: "FAILED",
          comparison,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      shadowStatus: comparison.mismatchCount === 0 ? "SUCCESS" : "FAILED",
      write,
      comparison,
      ...(comparison.mismatchCount === 0 ? {} : { error: "SNAPSHOT_V3_COHORT_MISMATCH" }),
    };
  } catch (error) {
    return {
      shadowStatus: "FAILED",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function persistLegacyThenSnapshotV3Shadow(params: {
  legacyInsert: () => Promise<number>;
  shadowRepository: ISnapshotV3ShadowRepository | null;
  syncRunId: string;
  rows: OrderSnapshotRow[];
  evaluationReferenceAt: string;
}): Promise<SnapshotV3ShadowRunResult> {
  const legacyRows = await params.legacyInsert();

  if (!isSnapshotV3ShadowEnabled()) {
    return { legacyRows, shadowStatus: "DISABLED" };
  }
  return {
    legacyRows,
    ...(await runSnapshotV3Shadow({
      shadowRepository: params.shadowRepository,
      syncRunId: params.syncRunId,
      rows: params.rows,
      evaluationReferenceAt: params.evaluationReferenceAt,
    })),
  };
}
