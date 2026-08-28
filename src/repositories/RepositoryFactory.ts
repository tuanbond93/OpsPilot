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
import type { IIncidentHistoryRepository } from "./interfaces/IIncidentHistoryRepository";
import type { IExceptionRepository } from "./interfaces/IExceptionRepository";

import { SupabaseSyncRunRepository } from "./supabase/SupabaseSyncRunRepository";
import { MockSyncRunRepository } from "./mock/MockSyncRunRepository";

import { SupabaseFollowupRepository } from "./supabase/SupabaseFollowupRepository";
import { MockFollowupRepository } from "./mock/MockFollowupRepository";
import { SupabaseIncidentHistoryRepository } from "./supabase/SupabaseIncidentHistoryRepository";
import { MockIncidentHistoryRepository } from "./mock/MockIncidentHistoryRepository";
import { SupabaseExceptionRepository } from "./supabase/SupabaseExceptionRepository";
import { MockExceptionRepository } from "./mock/MockExceptionRepository";

import { SupabasePlannerRepository } from "./supabase/SupabasePlannerRepository";
import { MockPlannerRepository } from "./mock/MockPlannerRepository";

import { SupabaseAiJobRepository } from "./supabase/SupabaseAiJobRepository";
import { MockAiJobRepository } from "./mock/MockAiJobRepository";

import type { IDashboardRepository } from "./interfaces/IDashboardRepository";
import { SupabaseDashboardRepository } from "./supabase/SupabaseDashboardRepository";
import { MockDashboardRepository } from "./mock/MockDashboardRepository";

import type { IOrderSnapshotRepository } from "./interfaces/IOrderSnapshotRepository";
import { SupabaseOrderSnapshotRepository } from "./supabase/SupabaseOrderSnapshotRepository";
import { MockOrderSnapshotRepository } from "./mock/MockOrderSnapshotRepository";

import type { IProjectionRunRepository } from "./interfaces/IProjectionRunRepository";
import { SupabaseProjectionRunRepository } from "@/connectors/supabase/repositories/projection-run-repository";
import { MockProjectionRunRepository } from "./mock/MockProjectionRunRepository";

import type { ISyncLockRepository } from "./interfaces/ISyncLockRepository";
import { SupabaseSyncLockRepository } from "./supabase/SupabaseSyncLockRepository";
import { MockSyncLockRepository } from "./mock/MockSyncLockRepository";

import type { ICopilotRepository } from "./interfaces/ICopilotRepository";
import { SupabaseCopilotRepository } from "./supabase/SupabaseCopilotRepository";
import { MockCopilotRepository } from "./mock/MockCopilotRepository";
import type { IDecisionRepository } from "./interfaces/IDecisionRepository";
import { SupabaseDecisionRepository } from "./supabase/SupabaseDecisionRepository";
import { MockDecisionRepository } from "./mock/MockDecisionRepository";
import type { IExecutionWorkOrderRepository } from "./interfaces/IExecutionWorkOrderRepository";
import { SupabaseExecutionWorkOrderRepository } from "./supabase/SupabaseExecutionWorkOrderRepository";
import { MockExecutionWorkOrderRepository } from "./mock/MockExecutionWorkOrderRepository";
import type { ITriageAuditRepository } from "./interfaces/ITriageAuditRepository";
import { SupabaseTriageAuditRepository } from "./supabase/SupabaseTriageAuditRepository";
import { MockTriageAuditRepository } from "./mock/MockTriageAuditRepository";

export class RepositoryFactory {
  private static incidentRepo: IIncidentRepository | null = null;
  private static aiJobRepo: IAiJobRepository | null = null;
  private static plannerRepo: IPlannerRepository | null = null;
  private static copilotRepo: ICopilotRepository | null = null;
  private static followupRepo: IFollowupRepository | null = null;
  private static notificationRepo: INotificationRepository | null = null;
  private static syncRunRepo: ISyncRunRepository | null = null;
  private static warehouseRepo: IWarehouseRepository | null = null;
  private static dashboardRepo: IDashboardRepository | null = null;
  private static historyRepo: IIncidentHistoryRepository | null = null;
  private static exceptionRepo: IExceptionRepository | null = null;
  private static orderSnapshotRepo: IOrderSnapshotRepository | null = null;
  private static syncLockRepo: ISyncLockRepository | null = null;
  private static decisionRepo: IDecisionRepository | null = null;
  private static executionWorkOrderRepo: IExecutionWorkOrderRepository | null = null;
  private static triageAuditRepo: ITriageAuditRepository | null = null;

  static registerDecisionRepository(repo: IDecisionRepository): void {
    this.decisionRepo = repo;
  }

  static registerSyncLockRepository(repo: ISyncLockRepository): void {
    this.syncLockRepo = repo;
  }

  static registerCopilotRepository(repo: ICopilotRepository): void {
    this.copilotRepo = repo;
  }

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

  static registerIncidentHistoryRepository(repo: IIncidentHistoryRepository): void {
    this.historyRepo = repo;
  }

  static registerExceptionRepository(repo: IExceptionRepository): void {
    this.exceptionRepo = repo;
  }

  static registerDashboardRepository(repo: IDashboardRepository): void {
    this.dashboardRepo = repo;
  }

  static registerOrderSnapshotRepository(repo: IOrderSnapshotRepository): void {
    this.orderSnapshotRepo = repo;
  }

  static registerTriageAuditRepository(repo: ITriageAuditRepository): void {
    this.triageAuditRepo = repo;
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

  static getAiJobRepository(client?: SupabaseClient | null): IAiJobRepository {
    if (client) {
      return new SupabaseAiJobRepository(client);
    }
    if (this.aiJobRepo) return this.aiJobRepo;

    if (this.shouldProvideMock()) {
      this.aiJobRepo = new MockAiJobRepository();
    } else {
      const defaultClient = createAdminClient();
      this.aiJobRepo = new SupabaseAiJobRepository(defaultClient);
    }
    return this.aiJobRepo;
  }

  static getPlannerRepository(client?: SupabaseClient | null): IPlannerRepository {
    if (client) {
      return new SupabasePlannerRepository(client);
    }
    if (this.plannerRepo) return this.plannerRepo;

    if (this.shouldProvideMock()) {
      this.plannerRepo = new MockPlannerRepository();
    } else {
      const defaultClient = createAdminClient();
      this.plannerRepo = new SupabasePlannerRepository(defaultClient);
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

  static getIncidentHistoryRepository(client?: SupabaseClient | null): IIncidentHistoryRepository {
    if (client) return new SupabaseIncidentHistoryRepository(client);
    if (this.historyRepo) return this.historyRepo;
    if (this.shouldProvideMock()) this.historyRepo = new MockIncidentHistoryRepository();
    else this.historyRepo = new SupabaseIncidentHistoryRepository(createAdminClient());
    return this.historyRepo;
  }

  static getExceptionRepository(client?: SupabaseClient | null): IExceptionRepository {
    if (client) return new SupabaseExceptionRepository(client);
    if (this.exceptionRepo) return this.exceptionRepo;
    if (this.shouldProvideMock()) this.exceptionRepo = new MockExceptionRepository();
    else this.exceptionRepo = new SupabaseExceptionRepository(createAdminClient());
    return this.exceptionRepo;
  }

  static getDashboardRepository(client?: SupabaseClient | null): IDashboardRepository {
    if (client) {
      return new SupabaseDashboardRepository(client);
    }
    if (this.dashboardRepo) return this.dashboardRepo;

    if (this.shouldProvideMock()) {
      this.dashboardRepo = new MockDashboardRepository();
    } else {
      const defaultClient = createAdminClient();
      this.dashboardRepo = new SupabaseDashboardRepository(defaultClient);
    }
    return this.dashboardRepo;
  }

  static getOrderSnapshotRepository(client?: SupabaseClient | null): IOrderSnapshotRepository {
    if (client) {
      return new SupabaseOrderSnapshotRepository(client);
    }
    if (this.orderSnapshotRepo) return this.orderSnapshotRepo;

    if (this.shouldProvideMock()) {
      this.orderSnapshotRepo = new MockOrderSnapshotRepository();
    } else {
      const defaultClient = createAdminClient();
      this.orderSnapshotRepo = new SupabaseOrderSnapshotRepository(defaultClient);
    }
    return this.orderSnapshotRepo;
  }

  static getWarehouseRepository(): IWarehouseRepository {
    if (!this.warehouseRepo) {
      throw new Error("[RepositoryFactory] WarehouseRepository not registered");
    }
    return this.warehouseRepo;
  }

  static getProjectionRunRepository(client?: SupabaseClient): IProjectionRunRepository {
    if (client) {
      return new SupabaseProjectionRunRepository(client);
    }
    if (this.shouldProvideMock()) {
      return new MockProjectionRunRepository();
    }
    const defaultClient = createAdminClient();
    return new SupabaseProjectionRunRepository(defaultClient);
  }

  /**
   * Determine if we should use mock/in-memory implementations based on global fallback policy.
   * Moving fallback logic selection away from repository query routines.
   */
  static shouldProvideMock(): boolean {
    return isFallbackAllowed();
  }

  static getSyncLockRepository(client?: SupabaseClient): ISyncLockRepository {
    if (this.syncLockRepo) {
      return this.syncLockRepo;
    }
    if (client) {
      return new SupabaseSyncLockRepository(client);
    }
    if (this.shouldProvideMock()) {
      return new MockSyncLockRepository();
    }
    const defaultClient = createAdminClient();
    return new SupabaseSyncLockRepository(defaultClient);
  }

  static getCopilotRepository(client?: SupabaseClient): ICopilotRepository {
    if (this.copilotRepo) {
      return this.copilotRepo;
    }
    if (client) {
      return new SupabaseCopilotRepository(client);
    }
    if (this.shouldProvideMock()) {
      return new MockCopilotRepository();
    }
    const defaultClient = createAdminClient();
    return new SupabaseCopilotRepository(defaultClient);
  }

  static getDecisionRepository(client?: SupabaseClient): IDecisionRepository {
    if (client) return new SupabaseDecisionRepository(client);
    if (this.decisionRepo) return this.decisionRepo;
    this.decisionRepo = this.shouldProvideMock()
      ? new MockDecisionRepository()
      : new SupabaseDecisionRepository(createAdminClient());
    return this.decisionRepo;
  }

  static getExecutionWorkOrderRepository(client?: SupabaseClient): IExecutionWorkOrderRepository {
    if (client) return new SupabaseExecutionWorkOrderRepository(client);
    if (this.executionWorkOrderRepo) return this.executionWorkOrderRepo;
    this.executionWorkOrderRepo = this.shouldProvideMock()
      ? new MockExecutionWorkOrderRepository()
      : new SupabaseExecutionWorkOrderRepository(createAdminClient());
    return this.executionWorkOrderRepo;
  }

  static getTriageAuditRepository(client?: SupabaseClient): ITriageAuditRepository {
    if (client) return new SupabaseTriageAuditRepository(client);
    if (this.triageAuditRepo) return this.triageAuditRepo;
    this.triageAuditRepo = this.shouldProvideMock()
      ? new MockTriageAuditRepository()
      : new SupabaseTriageAuditRepository(createAdminClient());
    return this.triageAuditRepo;
  }

  static clear(): void {
    this.incidentRepo = null;
    this.aiJobRepo = null;
    this.plannerRepo = null;
    this.copilotRepo = null;
    this.followupRepo = null;
    this.notificationRepo = null;
    this.syncRunRepo = null;
    this.warehouseRepo = null;
    this.dashboardRepo = null;
    this.historyRepo = null;
    this.exceptionRepo = null;
    this.orderSnapshotRepo = null;
    this.syncLockRepo = null;
    this.decisionRepo = null;
    this.executionWorkOrderRepo = null;
    this.triageAuditRepo = null;
  }
}
