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
import { NoOpAiWorkerService } from './impl/NoOpAiWorkerService';
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
    return new NoOpAiWorkerService();
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
