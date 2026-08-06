import { SupabaseClient } from '@supabase/supabase-js';
import { RepositoryFactory } from '../repositories/RepositoryFactory';

import { IIncidentService } from './interfaces/IIncidentService';
import { IFollowupService } from './interfaces/IFollowupService';
import { ISyncService } from './interfaces/ISyncService';
import { IPlannerService } from './interfaces/IPlannerService';
import { IAiWorkerService } from './interfaces/IAiWorkerService';
import { IDashboardService } from './interfaces/IDashboardService';
import { IProjectionService } from './interfaces/IProjectionService';

import { NoOpIncidentService } from './impl/NoOpIncidentService';
import { NoOpFollowupService } from './impl/NoOpFollowupService';
import { NoOpSyncService } from './impl/NoOpSyncService';
import { NoOpPlannerService } from './impl/NoOpPlannerService';

import { AiWorkerService } from './impl/AiWorkerService';

import { RootCauseAgent } from '../agents/root-cause';
import { ActionPlannerAgent } from '../agents/action-planner';


import type { INotificationService } from "./interfaces/INotificationService";
import { NotificationService } from "./impl/NotificationService";
import { ActionQueue } from "@/engine/action-queue";
import { ConsoleProvider } from "@/notifications/providers/console";
import { TelegramProvider } from "@/notifications/providers/telegram";
import { DashboardService } from './impl/DashboardService';
import { NoOpProjectionService } from './impl/NoOpProjectionService';

export class ServiceFactory {
  public static getIncidentService(client?: SupabaseClient): IIncidentService {
    return new NoOpIncidentService();
  }
  public static getFollowupService(client?: SupabaseClient): IFollowupService {
    return new NoOpFollowupService();
  }
  public static getSyncService(client?: SupabaseClient): ISyncService {
    return new NoOpSyncService();
  }
  public static getPlannerService(client?: SupabaseClient): IPlannerService {
    return new NoOpPlannerService();
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
    return new NoOpProjectionService();
  }
}
