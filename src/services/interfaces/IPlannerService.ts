export interface GeneratePlanOptions {
  provider?: string;
  model?: string;
  forceRegenerate?: boolean;
  requestedBy?: string;
}

export interface IPlannerService {
  generatePlan(
    incidentId: string,
    options?: GeneratePlanOptions
  ): Promise<{
    ok: boolean;
    cached?: boolean;
    runId?: string;
    result?: any;
    error?: string;
    message?: string;
  }>;

  getPlannerRunByIncidentId(
    incidentId: string
  ): Promise<{
    ok: boolean;
    aiStatus?: string;
    aiJob?: any;
    run?: any;
    reviewEvents?: any[];
    message?: string;
    error?: string;
  }>;

  reviewPlannerRun(
    id: string,
    decision: string,
    reviewedBy: string,
    note?: string | null
  ): Promise<{
    ok: boolean;
    run?: any;
    idempotent?: boolean;
    reviewedBy?: string;
    decision?: string;
    error?: string;
    message?: string;
  }>;

  listPlannerRuns(
    incidentId?: string,
    limit?: number
  ): Promise<{
    ok: boolean;
    runs?: any[];
    error?: string;
    message?: string;
  }>;

  getPlannerRun(
    id: string
  ): Promise<{
    ok: boolean;
    run?: any;
    reviewEvents?: any[];
    error?: string;
    message?: string;
  }>;
}