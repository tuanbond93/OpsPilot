/**
 * OpsPilot Load-Shedding & Durable Work Prototype - Types
 */

import type { NormalizedRillnetOrder } from "@/connectors/rillnet/types";
import type { FollowupCaseRow } from "@/connectors/supabase/types";

export interface ActiveWorkingSetClassification {
  totalSourceOrders: number;
  activeOrders: number;
  terminalRecent: number;
  terminalOld: number;
  workingSet: NormalizedRillnetOrder[];
  reductionPercent: number;
}

export interface CaseClassification {
  totalCases: number;
  changedCases: number;
  unchangedCases: number;
  dueCases: number;
  notDueCases: number;
  activeCases: number;
  closedCases: number;
}

export interface CaseMaterialFingerprintInput {
  status: string;
  memberCodes?: string[];
  memberCount?: number;
  backlogCount?: number;
  explanationState?: string;
  latestTrackingState?: string;
  slaAgeHours?: number | null;
  priorityScore?: number | null;
  reasonCode?: string;
  warehouseId?: string;
}

export interface FollowupWorkUnit {
  checkpoint_id: string;
  pipeline_version: string;
  warehouse_id?: string;
  chunk_index: number;
  case_ids: string[];
  deterministic_work_key: string;
}

export interface CheckpointSchedulingMetadata {
  checkpointAt: string;
  v1EligibleAt: string;
  v2EligibleAt: string;
  isV1Eligible: (nowMs?: number) => boolean;
  isV2Eligible: (nowMs?: number) => boolean;
}

export interface WorkerBudgetOptions {
  maxBudgetMs?: number; // default: 45_000 (45s)
  gracefulYieldThresholdMs?: number; // default: 35_000 (35s)
}

export interface WorkingSetSimulationResult {
  inputOrders: number;
  activeWorkingSet: number;
  candidateCases: number;
  skippedTerminal: number;
  skippedUnchanged: number;
  skippedNotDue: number;
  totalHeavyProcessingCases: number;
  numberOfChunks: number;
  dbQueryCount: number;
  dbWriteCount: number;
  aiCallsAvoided: number;
  estimatedRuntimeMs: number;
  maxWorkUnitRuntimeMs: number;
}
