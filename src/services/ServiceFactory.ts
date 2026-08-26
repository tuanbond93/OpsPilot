import { SupabaseClient } from '@supabase/supabase-js';
import { RepositoryFactory } from '../repositories/RepositoryFactory';

import { IIncidentService } from './interfaces/IIncidentService';
import { IFollowupService } from './interfaces/IFollowupService';
import { ISyncService } from './interfaces/ISyncService';
import { IPlannerService } from './interfaces/IPlannerService';
import { IAiWorkerService } from './interfaces/IAiWorkerService';
import { IDashboardService } from './interfaces/IDashboardService';
import { IProjectionService } from './interfaces/IProjectionService';

import { IncidentService } from './impl/IncidentService';
import { FollowupService } from './impl/FollowupService';
import { SyncService } from './impl/SyncService';
import { PlannerService } from './impl/PlannerService';

import { AiWorkerService } from './impl/AiWorkerService';

import { RootCauseAgent } from '../agents/root-cause';
import { ActionPlannerAgent } from '../agents/action-planner';


import type { INotificationService } from "./interfaces/INotificationService";
import { NotificationService } from "./impl/NotificationService";
import { ActionQueue } from "@/engine/action-queue";
import { ConsoleProvider } from "@/notifications/providers/console";
import { TelegramProvider } from "@/notifications/providers/telegram";
import { DashboardService } from './impl/DashboardService';
import { ProjectionService } from './impl/ProjectionService';
import { SupabaseWarehouseProjection } from '@/projections/adapters/SupabaseWarehouseProjection';
import { SupabaseIncidentProjection } from '@/projections/adapters/SupabaseIncidentProjection';
import { SupabasePlannerProjection } from '@/projections/adapters/SupabasePlannerProjection';
import { SupabaseNotificationProjection } from '@/projections/adapters/SupabaseNotificationProjection';

import type { ICopilotService } from './interfaces/ICopilotService';
import { CopilotService } from './impl/CopilotService';
import type { ICopilotQualityService } from './interfaces/ICopilotQualityService';
import { CopilotQualityService } from './impl/CopilotQualityService';
import type { IDecisionService } from './interfaces/IDecisionService';
import { DecisionService } from './impl/DecisionService';
import type { IDecisionPilotService } from './interfaces/IDecisionPilotService';
import { DecisionPilotService } from './impl/DecisionPilotService';

export class ServiceFactory {
  public static getDecisionService(client?: SupabaseClient): IDecisionService {
    return new DecisionService(RepositoryFactory.getDecisionRepository(client));
  }

  public static getDecisionPilotService(client?: SupabaseClient): IDecisionPilotService {
    return new DecisionPilotService(
      RepositoryFactory.getIncidentRepository(client),
      RepositoryFactory.getIncidentHistoryRepository(client),
      RepositoryFactory.getFollowupRepository(client),
      RepositoryFactory.getPlannerRepository(client),
      this.getDecisionService(client)
    );
  }
  public static getCopilotService(client?: SupabaseClient): ICopilotService {
    const copilotRepo = RepositoryFactory.getCopilotRepository(client);
    return new CopilotService(copilotRepo);
  }

  public static getCopilotQualityService(client?: SupabaseClient): ICopilotQualityService {
    const copilotRepo = RepositoryFactory.getCopilotRepository(client);
    return new CopilotQualityService(copilotRepo);
  }

  public static getIncidentService(client?: SupabaseClient): IIncidentService {


    const incidentRepo = client ? RepositoryFactory.getIncidentRepository(client) : RepositoryFactory.getIncidentRepository();
    const historyRepo = client ? RepositoryFactory.getIncidentHistoryRepository(client) : RepositoryFactory.getIncidentHistoryRepository();
    const orderSnapshotRepo = client ? RepositoryFactory.getOrderSnapshotRepository(client) : null;
    const rootCauseAgent = new RootCauseAgent();
    return new IncidentService(incidentRepo, historyRepo, rootCauseAgent, orderSnapshotRepo);
  }
  public static getFollowupService(client?: SupabaseClient): IFollowupService {
    const followupRepo = client ? RepositoryFactory.getFollowupRepository(client) : RepositoryFactory.getFollowupRepository();
    const actionQueue = new ActionQueue(client);
    return new FollowupService(followupRepo, actionQueue);
  }
  public static getSyncService(client?: SupabaseClient): ISyncService {
    const syncRunRepo = RepositoryFactory.getSyncRunRepository(client);
    const orderSnapshotRepo = RepositoryFactory.getOrderSnapshotRepository(client);
    const incidentRepo = RepositoryFactory.getIncidentRepository(client);
    const incidentHistoryRepo = RepositoryFactory.getIncidentHistoryRepository(client);
    const exceptionRepo = RepositoryFactory.getExceptionRepository(client);
    const followupRepo = RepositoryFactory.getFollowupRepository(client);
    const aiJobRepo = RepositoryFactory.getAiJobRepository(client);
    const actionQueue = new ActionQueue(client);
    const syncLockRepo = RepositoryFactory.getSyncLockRepository(client);

    return new SyncService(
      syncRunRepo,
      orderSnapshotRepo,
      incidentRepo,
      incidentHistoryRepo,
      exceptionRepo,
      followupRepo,
      aiJobRepo,
      actionQueue,
      syncLockRepo
    );
  }
  public static getPlannerService(client?: SupabaseClient): IPlannerService {
    const plannerRepo = RepositoryFactory.getPlannerRepository(client);
    const incidentRepo = RepositoryFactory.getIncidentRepository(client);
    const historyRepo = RepositoryFactory.getIncidentHistoryRepository(client);
    const followupRepo = RepositoryFactory.getFollowupRepository(client);
    const exceptionRepo = RepositoryFactory.getExceptionRepository(client);
    const aiJobRepo = RepositoryFactory.getAiJobRepository(client);
    const actionQueue = new ActionQueue(client);
    const rootCauseAgent = new RootCauseAgent();
    const actionPlannerAgent = new ActionPlannerAgent(plannerRepo);

    return new PlannerService(
      plannerRepo,
      incidentRepo,
      historyRepo,
      followupRepo,
      exceptionRepo,
      aiJobRepo,
      actionQueue,
      rootCauseAgent,
      actionPlannerAgent
    );
  }
  public static getAiWorkerService(client?: SupabaseClient): IAiWorkerService {
    if (!client) {
      throw new Error("SupabaseClient is required to instantiate AiWorkerService");
    }
    const aiJobRepo = RepositoryFactory.getAiJobRepository(client);
    const incidentRepo = RepositoryFactory.getIncidentRepository(client);
    const followupRepo = RepositoryFactory.getFollowupRepository(client);
    const plannerRepo = RepositoryFactory.getPlannerRepository(client);
    
    // Manually instantiate missing repos
    const historyRepo = RepositoryFactory.getIncidentHistoryRepository(client);
    const exceptionRepo = RepositoryFactory.getExceptionRepository(client);
    
    // Instantiate agents
    const rootCauseAgent = new RootCauseAgent();
    const actionPlannerAgent = new ActionPlannerAgent(plannerRepo);

    return new AiWorkerService(
      aiJobRepo,
      incidentRepo,
      historyRepo,
      followupRepo,
      plannerRepo,
      exceptionRepo,
      rootCauseAgent,
      actionPlannerAgent
    );
  }
  
  public static getNotificationService(client?: SupabaseClient): INotificationService {
    const queue = new ActionQueue(client);
    const followupRepo = client ? RepositoryFactory.getFollowupRepository(client) : null;
    const providers = [new ConsoleProvider(), new TelegramProvider()];
    return new NotificationService(queue, followupRepo, providers);
  }
  public static getDashboardService(client?: SupabaseClient): IDashboardService {
    return new DashboardService(
      RepositoryFactory.getDashboardRepository(client),
      RepositoryFactory.getAiJobRepository(client),
      RepositoryFactory.getSyncRunRepository(client)
    );
  }
  public static getProjectionService(client?: SupabaseClient): IProjectionService {
    const warehouseProj = client ? new SupabaseWarehouseProjection(client) : null;
    const incidentProj = client ? new SupabaseIncidentProjection(client) : null;
    const plannerProj = client ? new SupabasePlannerProjection(client) : null;
    const notifProj = client ? new SupabaseNotificationProjection(client) : null;
    const projectionRunRepo = RepositoryFactory.getProjectionRunRepository(client);

    return new ProjectionService(
      warehouseProj,
      incidentProj,
      plannerProj,
      notifProj,
      projectionRunRepo
    );
  }
}
