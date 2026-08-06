import type { Incident } from "@/engine/incident";
import type { IncidentHistoryRow } from "@/connectors/supabase/types";
import type { FollowupConfig } from "@/config/followup";
import type { ProcessedFollowupItem } from "@/engine/followup/followup-engine";

export interface IFollowupService {
  getAllCases(): Promise<{
    totalCases: number;
    cases: any[];
  }>;

  getCaseById(
    id: string
  ): Promise<{
    followupCase: any;
    events: any[];
  } | null>;

  confirmFollowupAction(
    id: string,
    action: string,
    confirmedBy?: string
  ): Promise<{
    ok: boolean;
    followupCase?: any;
    event?: any;
    error?: string;
    message?: string;
  }>;

  handleFollowupStateConfirmation(
    action: any,
    confirmedBy: string
  ): Promise<any>;

  processIncidentFollowups(
    incidents: Incident[],
    historyMap?: Map<string, IncidentHistoryRow[]>,
    config?: FollowupConfig,
    referenceTimeMs?: number
  ): Promise<ProcessedFollowupItem[]>;
}