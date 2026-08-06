const fs = require('fs');

let c = fs.readFileSync('src/services/ServiceFactory.ts', 'utf8');

const imports = `
import { AiWorkerService } from './impl/AiWorkerService';
import { IncidentHistoryRepository, ExceptionRepository } from '../connectors/supabase';
import { RootCauseAgent } from '../agents/root-cause';
import { ActionPlannerAgent } from '../agents/action-planner';
`;

c = c.replace("import { NoOpAiWorkerService } from './impl/NoOpAiWorkerService';", imports);

const method = `
  public static getAiWorkerService(client?: SupabaseClient): IAiWorkerService {
    if (!client) {
      throw new Error("SupabaseClient is required to instantiate AiWorkerService");
    }
    const aiJobRepo = RepositoryFactory.getAiJobRepository(client);
    const incidentRepo = RepositoryFactory.getIncidentRepository(client);
    const followupRepo = RepositoryFactory.getFollowupRepository(client);
    const plannerRepo = RepositoryFactory.getPlannerRepository(client);
    
    // Manually instantiate missing repos
    const historyRepo = new IncidentHistoryRepository(client);
    const exceptionRepo = new ExceptionRepository(client);
    
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
`;

c = c.replace(
  'public static getAiWorkerService(client?: SupabaseClient): IAiWorkerService {\n    return new NoOpAiWorkerService();\n  }',
  method.trim()
);

fs.writeFileSync('src/services/ServiceFactory.ts', c);
