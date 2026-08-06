import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PlannerRunRow,
  PlannerReviewEventRow,
  PlannerRunStatus,
} from "../types";
import { isFallbackAllowed } from "../fallback-policy";

export class PlannerRepository {
  private inMemoryRuns: PlannerRunRow[] = [];
  private inMemoryEvents: PlannerReviewEventRow[] = [];

  constructor(private client?: SupabaseClient | null) {}

  clearMemory(): void {
    this.inMemoryRuns = [];
    this.inMemoryEvents = [];
  }

  async createPlannerRun(run: Partial<PlannerRunRow>): Promise<PlannerRunRow> {
    const nowIso = new Date().toISOString();
    const newRun: Partial<PlannerRunRow> = {
      incident_id: run.incident_id,
      followup_case_id: run.followup_case_id || null,
      status: run.status || "DRAFT",
      context_hash: run.context_hash || "",
      prompt_version: run.prompt_version || 1,
      provider: run.provider || "deterministic_fallback",
      model: run.model || "none",
      result: run.result || {},
      created_at: run.created_at || nowIso,
      reviewed_at: run.reviewed_at || null,
      reviewed_by: run.reviewed_by || null,
    };

    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("planner_runs")
          .insert([newRun])
          .select()
          .single();

        if (error) {
          if (error.code === "23505") { // Unique constraint violation on active DRAFT run
            const existingDraft = await this.getPlannerRunByContextHashAndVersion(
              newRun.incident_id!,
              newRun.context_hash!,
              newRun.prompt_version!,
              "DRAFT"
            );
            if (existingDraft) return existingDraft;
          }
          if (!isFallbackAllowed()) throw error;
        }

        if (data) return data;
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    if (newRun.status === "DRAFT") {
      const existingDraft = this.inMemoryRuns.find(
        (r) =>
          r.incident_id === newRun.incident_id &&
          r.context_hash === newRun.context_hash &&
          r.prompt_version === newRun.prompt_version &&
          r.status === "DRAFT"
      );
      if (existingDraft) return existingDraft;
    }

    const id = run.id || `prun-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const fullRow: PlannerRunRow = {
      id,
      incident_id: newRun.incident_id!,
      followup_case_id: newRun.followup_case_id,
      status: newRun.status as PlannerRunStatus,
      context_hash: newRun.context_hash!,
      prompt_version: newRun.prompt_version!,
      provider: newRun.provider!,
      model: newRun.model!,
      result: newRun.result as Record<string, unknown>,
      created_at: newRun.created_at,
      reviewed_at: newRun.reviewed_at,
      reviewed_by: newRun.reviewed_by,
    };

    this.inMemoryRuns.push(fullRow);
    return fullRow;
  }

  async getPlannerRunById(id: string): Promise<PlannerRunRow | null> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("planner_runs")
          .select("*")
          .eq("id", id)
          .maybeSingle();

        if (!error && data) return data;
        if (!isFallbackAllowed() && error) throw error;
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    return this.inMemoryRuns.find((r) => r.id === id) || null;
  }

  async getPlannerRunByContextHashAndVersion(
    incidentId: string,
    contextHash: string,
    promptVersion: number,
    status?: PlannerRunStatus
  ): Promise<PlannerRunRow | null> {
    if (this.client) {
      try {
        let query = this.client
          .from("planner_runs")
          .select("*")
          .eq("incident_id", incidentId)
          .eq("context_hash", contextHash)
          .eq("prompt_version", promptVersion);

        if (status) {
          query = query.eq("status", status);
        }

        const { data, error } = await query
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!error && data) return data;
        if (!isFallbackAllowed() && error) throw error;
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    const matches = this.inMemoryRuns.filter(
      (r) =>
        r.incident_id === incidentId &&
        r.context_hash === contextHash &&
        r.prompt_version === promptVersion &&
        (!status || r.status === status)
    );

    return (
      matches.sort(
        (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
      )[0] || null
    );
  }

  async updatePlannerRunStatus(
    id: string,
    status: PlannerRunStatus,
    reviewedBy?: string,
    reviewedAt: string = new Date().toISOString()
  ): Promise<PlannerRunRow | null> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("planner_runs")
          .update({
            status,
            reviewed_by: reviewedBy || null,
            reviewed_at: reviewedAt,
          })
          .eq("id", id)
          .select()
          .maybeSingle();

        if (!error && data) return data;
        if (!isFallbackAllowed() && error) throw error;
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    const run = this.inMemoryRuns.find((r) => r.id === id);
    if (!run) return null;

    run.status = status;
    run.reviewed_by = reviewedBy || null;
    run.reviewed_at = reviewedAt;
    return run;
  }

  async getAllPlannerRuns(incidentId?: string, limit: number = 50): Promise<PlannerRunRow[]> {
    if (this.client) {
      try {
        let query = this.client.from("planner_runs").select("*");

        if (incidentId) {
          query = query.eq("incident_id", incidentId);
        }

        const { data, error } = await query
          .order("created_at", { ascending: false })
          .limit(limit);

        if (!error && data) return data;
        if (!isFallbackAllowed()) throw error || new Error("getAllPlannerRuns failed");
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    let filtered = [...this.inMemoryRuns];
    if (incidentId) {
      filtered = filtered.filter((r) => r.incident_id === incidentId);
    }

    return filtered
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, limit);
  }

  async getLatestPlannerRunByIncidentId(incidentId: string): Promise<PlannerRunRow | null> {
    const runs = await this.getAllPlannerRuns(incidentId, 1);
    return runs[0] || null;
  }

  async insertReviewEvent(event: Partial<PlannerReviewEventRow>): Promise<PlannerReviewEventRow> {
    const nowIso = new Date().toISOString();
    const newEvent: Partial<PlannerReviewEventRow> = {
      planner_run_id: event.planner_run_id,
      event_type: event.event_type || "CREATED",
      actor: event.actor || "system",
      note: event.note || null,
      created_at: event.created_at || nowIso,
    };

    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("planner_review_events")
          .insert([newEvent])
          .select()
          .single();

        if (!error && data) return data;
        if (!isFallbackAllowed()) throw error || new Error("insertReviewEvent failed");
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    const id = event.id || `pevt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const fullRow: PlannerReviewEventRow = {
      id,
      planner_run_id: newEvent.planner_run_id!,
      event_type: newEvent.event_type!,
      actor: newEvent.actor!,
      note: newEvent.note,
      created_at: newEvent.created_at,
    };
    this.inMemoryEvents.push(fullRow);
    return fullRow;
  }

  async getReviewEventsByRunId(plannerRunId: string): Promise<PlannerReviewEventRow[]> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("planner_review_events")
          .select("*")
          .eq("planner_run_id", plannerRunId)
          .order("created_at", { ascending: true });

        if (!error && data) return data;
        if (!isFallbackAllowed()) throw error || new Error("getReviewEventsByRunId failed");
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    return this.inMemoryEvents
      .filter((e) => e.planner_run_id === plannerRunId)
      .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());
  }

  async getRecentReviewEvents(limit: number = 30): Promise<PlannerReviewEventRow[]> {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from("planner_review_events")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);

        if (!error && data) return data;
        if (!isFallbackAllowed()) throw error || new Error("getRecentReviewEvents failed");
      } catch (err) {
        if (!isFallbackAllowed()) throw err;
      }
    } else if (!isFallbackAllowed()) {
      throw new Error("SupabaseClient unavailable in production mode");
    }

    return [...this.inMemoryEvents]
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, limit);
  }
}
