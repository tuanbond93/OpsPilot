import type { SupabaseClient } from "@supabase/supabase-js";
import { isFallbackAllowed } from "@/connectors/supabase/fallback-policy";
import { createAdminClient } from "@/connectors/supabase";
import type { IIncidentRepository } from "./interfaces/IIncidentRepository";
import type { IAiJobRepository } from "./interfaces/IAiJobRepository";
import type { IPlannerRepository } from "./interfaces/IPlannerRepository";
import type { IFollowupRepository } from "./interfaces/IFollowupRepository";
import type { INotificationRepository } from "./interfaces/INotificationRepository";
import type { ISyncRunRepository } from "./interfaces/ISyncRunRepository";
import type { IWarehouseRepository } from "./interfaces/IWarehouseRepository";

import { SupabaseIncidentRepository } from "./supabase/SupabaseIncidentRepository";
import { MockIncidentRepository } from "./mock/MockIncidentRepository";

import { SupabaseSyncRunRepository } from "./supabase/SupabaseSyncRunRepository";
import { MockSyncRunRepository } from "./mock/MockSyncRunRepository";

import { SupabaseFollowupRepository } from "./supabase/SupabaseFollowupRepository";
import { MockFollowupRepository } from "./mock/MockFollowupRepository";

export class RepositoryFactory {
  private static incidentRepo: IIncidentRepository | null = null;
  private static aiJobRepo: IAiJobRepository | null = null;
  private static plannerRepo: IPlannerRepository | null = null;
  private static followupRepo: IFollowupRepository | null = null;
  private static notificationRepo: INotificationRepository | null = null;
  private static syncRunRepo: ISyncRunRepository | null = null;
  private static warehouseRepo: IWarehouseRepository | null = null;

  // Setters for DI / Custom mock registrations
  static registerIncidentRepository(repo: IIncidentRepository): void {
    this.incidentRepo = repo;
  }

  static registerAiJobRepository(repo: IAiJobRepository): void {
    this.aiJobRepo = repo;
  }

  static registerPlannerRepository(repo: IPlannerRepository): void {
    this.plannerRepo = repo;
  }

  static registerFollowupRepository(repo: IFollowupRepository): void {
    this.followupRepo = repo;
  }

  static registerNotificationRepository(repo: INotificationRepository): void {
    this.notificationRepo = repo;
  }

  static registerSyncRunRepository(repo: ISyncRunRepository): void {
    this.syncRunRepo = repo;
  }

  static registerWarehouseRepository(repo: IWarehouseRepository): void {
    this.warehouseRepo = repo;
  }

  // Resolvers
  static getIncidentRepository(client?: SupabaseClient | null): IIncidentRepository {
    if (client) {
      return new SupabaseIncidentRepository(client);
    }
    if (this.incidentRepo) return this.incidentRepo;

    if (this.shouldProvideMock()) {
      this.incidentRepo = new MockIncidentRepository();
    } else {
      const defaultClient = createAdminClient();
      this.incidentRepo = new SupabaseIncidentRepository(defaultClient);
    }
    return this.incidentRepo;
  }

  static getAiJobRepository(): IAiJobRepository {
    if (!this.aiJobRepo) {
      throw new Error("[RepositoryFactory] AiJobRepository not registered");
    }
    return this.aiJobRepo;
  }

  static getPlannerRepository(): IPlannerRepository {
    if (!this.plannerRepo) {
      throw new Error("[RepositoryFactory] PlannerRepository not registered");
    }
    return this.plannerRepo;
  }

  static getFollowupRepository(client?: SupabaseClient | null): IFollowupRepository {
    if (client) {
      return new SupabaseFollowupRepository(client);
    }
    if (this.followupRepo) return this.followupRepo;

    if (this.shouldProvideMock()) {
      this.followupRepo = new MockFollowupRepository();
    } else {
      const defaultClient = createAdminClient();
      this.followupRepo = new SupabaseFollowupRepository(defaultClient);
    }
    return this.followupRepo;
  }

  static getNotificationRepository(): INotificationRepository {
    if (!this.notificationRepo) {
      throw new Error("[RepositoryFactory] NotificationRepository not registered");
    }
    return this.notificationRepo;
  }

  static getSyncRunRepository(client?: SupabaseClient | null): ISyncRunRepository {
    if (client) {
      return new SupabaseSyncRunRepository(client);
    }
    if (this.syncRunRepo) return this.syncRunRepo;

    if (this.shouldProvideMock()) {
      this.syncRunRepo = new MockSyncRunRepository();
    } else {
      const defaultClient = createAdminClient();
      this.syncRunRepo = new SupabaseSyncRunRepository(defaultClient);
    }
    return this.syncRunRepo;
  }

  static getWarehouseRepository(): IWarehouseRepository {
    if (!this.warehouseRepo) {
      throw new Error("[RepositoryFactory] WarehouseRepository not registered");
    }
    return this.warehouseRepo;
  }

  /**
   * Determine if we should use mock/in-memory implementations based on global fallback policy.
   * Moving fallback logic selection away from repository query routines.
   */
  static shouldProvideMock(): boolean {
    return isFallbackAllowed();
  }

  static clear(): void {
    this.incidentRepo = null;
    this.aiJobRepo = null;
    this.plannerRepo = null;
    this.followupRepo = null;
    this.notificationRepo = null;
    this.syncRunRepo = null;
    this.warehouseRepo = null;
  }
}
