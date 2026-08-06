const fs = require('fs');
const path = require('path');

// 1. Interfaces
const iHistRepo = `
import type { IncidentHistoryRow } from "@/connectors/supabase/types";
import type { Incident } from "@/engine/incident";

export interface IIncidentHistoryRepository {
  clearMemory?(): void;
  insertHistoryRecords(
    incidentMap: Map<string, string>,
    incidents: Incident[],
    syncRunId: string,
    recordedAt?: string
  ): Promise<number>;
  getHistoriesByIncidentIds(incidentIds: string[]): Promise<Map<string, IncidentHistoryRow[]>>;
  getHistoryByIncidentId(incidentId: string): Promise<IncidentHistoryRow[]>;
  getIncidentHistory(incidentId: string): Promise<IncidentHistoryRow[]>;
}
`;
fs.writeFileSync('src/repositories/interfaces/IIncidentHistoryRepository.ts', iHistRepo.trim() + '\n');

const iExcRepo = `
import type { OrderExceptionRow } from "@/connectors/supabase/types";

export interface IExceptionRepository {
  getActiveExceptions(referenceTime?: string): Promise<OrderExceptionRow[]>;
  getActiveExceptionOrderCodes(referenceTime?: string): Promise<Set<string>>;
}
`;
fs.writeFileSync('src/repositories/interfaces/IExceptionRepository.ts', iExcRepo.trim() + '\n');

// 2. Mocks
const mockHistRepo = `
import type { IIncidentHistoryRepository } from "../interfaces/IIncidentHistoryRepository";
import type { IncidentHistoryRow } from "@/connectors/supabase/types";
import type { Incident } from "@/engine/incident";

export class MockIncidentHistoryRepository implements IIncidentHistoryRepository {
  private inMemoryHistory: IncidentHistoryRow[] = [];

  clearMemory(): void {
    this.inMemoryHistory = [];
  }

  async insertHistoryRecords(
    incidentMap: Map<string, string>,
    incidents: Incident[],
    syncRunId: string,
    recordedAt: string = new Date().toISOString()
  ): Promise<number> {
    const rows: IncidentHistoryRow[] = [];
    for (const inc of incidents) {
      const dbId = incidentMap.get(inc.incidentKey);
      if (!dbId) continue;
      rows.push({
        incident_id: dbId,
        sync_run_id: syncRunId,
        recorded_at: recordedAt,
        affected_order_count: inc.affectedOrderCount,
        average_age_hours: inc.averageAgeHours ? Math.round(inc.averageAgeHours * 10) / 10 : undefined,
        maximum_age_hours: inc.maximumAgeHours ? Math.round(inc.maximumAgeHours * 10) / 10 : undefined,
        priority_score: Math.round(inc.priorityScore),
        sample_order_codes: inc.sampleOrderCodes ? inc.sampleOrderCodes.slice(0, 5) : [],
      });
    }
    this.inMemoryHistory.push(...rows);
    return rows.length;
  }

  async getHistoriesByIncidentIds(incidentIds: string[]): Promise<Map<string, IncidentHistoryRow[]>> {
    const resultMap = new Map<string, IncidentHistoryRow[]>();
    for (const id of incidentIds) {
      resultMap.set(id, []);
    }
    for (const row of this.inMemoryHistory) {
      if (incidentIds.includes(row.incident_id)) {
        resultMap.get(row.incident_id)?.push(row);
      }
    }
    return resultMap;
  }

  async getHistoryByIncidentId(incidentId: string): Promise<IncidentHistoryRow[]> {
    const map = await this.getHistoriesByIncidentIds([incidentId]);
    return map.get(incidentId) || [];
  }

  async getIncidentHistory(incidentId: string): Promise<IncidentHistoryRow[]> {
    return this.getHistoryByIncidentId(incidentId);
  }
}
`;
fs.writeFileSync('src/repositories/mock/MockIncidentHistoryRepository.ts', mockHistRepo.trim() + '\n');

const mockExcRepo = `
import type { IExceptionRepository } from "../interfaces/IExceptionRepository";
import type { OrderExceptionRow } from "@/connectors/supabase/types";

export class MockExceptionRepository implements IExceptionRepository {
  async getActiveExceptions(referenceTime?: string): Promise<OrderExceptionRow[]> {
    return [];
  }
  async getActiveExceptionOrderCodes(referenceTime?: string): Promise<Set<string>> {
    return new Set();
  }
}
`;
fs.writeFileSync('src/repositories/mock/MockExceptionRepository.ts', mockExcRepo.trim() + '\n');

// 3. Supabase Repos
const supHistRepo = fs.readFileSync('src/connectors/supabase/repositories/incident-history-repository.ts', 'utf8')
  .replace('export class IncidentHistoryRepository', 'export class SupabaseIncidentHistoryRepository implements IIncidentHistoryRepository')
  .replace('import type { IncidentHistoryRow } from "../types";', 'import type { IncidentHistoryRow } from "@/connectors/supabase/types";')
  .replace('import { isFallbackAllowed } from "../fallback-policy";', 'import { isFallbackAllowed } from "@/connectors/supabase/fallback-policy";\nimport type { IIncidentHistoryRepository } from "../interfaces/IIncidentHistoryRepository";');
fs.writeFileSync('src/repositories/supabase/SupabaseIncidentHistoryRepository.ts', supHistRepo);

const supExcRepo = fs.readFileSync('src/connectors/supabase/repositories/exception-repository.ts', 'utf8')
  .replace('export class ExceptionRepository', 'export class SupabaseExceptionRepository implements IExceptionRepository')
  .replace('import type { OrderExceptionRow } from "../types";', 'import type { OrderExceptionRow } from "@/connectors/supabase/types";\nimport type { IExceptionRepository } from "../interfaces/IExceptionRepository";');
fs.writeFileSync('src/repositories/supabase/SupabaseExceptionRepository.ts', supExcRepo);

// 4. Update RepositoryFactory
let rf = fs.readFileSync('src/repositories/RepositoryFactory.ts', 'utf8');
rf = rf.replace(
  'import { MockIncidentRepository } from "./mock/MockIncidentRepository";',
  'import { MockIncidentRepository } from "./mock/MockIncidentRepository";\nimport type { IIncidentHistoryRepository } from "./interfaces/IIncidentHistoryRepository";\nimport type { IExceptionRepository } from "./interfaces/IExceptionRepository";'
);
rf = rf.replace(
  'import { MockFollowupRepository } from "./mock/MockFollowupRepository";',
  'import { MockFollowupRepository } from "./mock/MockFollowupRepository";\nimport { SupabaseIncidentHistoryRepository } from "./supabase/SupabaseIncidentHistoryRepository";\nimport { MockIncidentHistoryRepository } from "./mock/MockIncidentHistoryRepository";\nimport { SupabaseExceptionRepository } from "./supabase/SupabaseExceptionRepository";\nimport { MockExceptionRepository } from "./mock/MockExceptionRepository";'
);
rf = rf.replace(
  'private static dashboardRepo: IDashboardRepository | null = null;',
  'private static dashboardRepo: IDashboardRepository | null = null;\n  private static historyRepo: IIncidentHistoryRepository | null = null;\n  private static exceptionRepo: IExceptionRepository | null = null;'
);
rf = rf.replace(
  'static registerDashboardRepository(repo: IDashboardRepository): void {',
  'static registerIncidentHistoryRepository(repo: IIncidentHistoryRepository): void {\n    this.historyRepo = repo;\n  }\n\n  static registerExceptionRepository(repo: IExceptionRepository): void {\n    this.exceptionRepo = repo;\n  }\n\n  static registerDashboardRepository(repo: IDashboardRepository): void {'
);
rf = rf.replace(
  'static getDashboardRepository(client?: SupabaseClient | null): IDashboardRepository {',
  `static getIncidentHistoryRepository(client?: SupabaseClient | null): IIncidentHistoryRepository {
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

  static getDashboardRepository(client?: SupabaseClient | null): IDashboardRepository {`
);
rf = rf.replace(
  'this.dashboardRepo = null;',
  'this.dashboardRepo = null;\n    this.historyRepo = null;\n    this.exceptionRepo = null;'
);
fs.writeFileSync('src/repositories/RepositoryFactory.ts', rf);

// 5. Delete old files and clean up connectors/supabase/index.ts
try {
  fs.unlinkSync('src/connectors/supabase/repositories/incident-history-repository.ts');
  fs.unlinkSync('src/connectors/supabase/repositories/exception-repository.ts');
} catch (e) {}

let cIdx = fs.readFileSync('src/connectors/supabase/index.ts', 'utf8');
cIdx = cIdx.replace(/export \* from "\.\/repositories\/incident-history-repository";\n/g, '');
cIdx = cIdx.replace(/export \* from "\.\/repositories\/exception-repository";\n/g, '');
fs.writeFileSync('src/connectors/supabase/index.ts', cIdx);

// 6. Update ServiceFactory
let sf = fs.readFileSync('src/services/ServiceFactory.ts', 'utf8');
sf = sf.replace("import { IncidentHistoryRepository, ExceptionRepository } from '../connectors/supabase';", "");
sf = sf.replace(
  "const historyRepo = new IncidentHistoryRepository(client);",
  "const historyRepo = RepositoryFactory.getIncidentHistoryRepository(client);"
);
sf = sf.replace(
  "const exceptionRepo = new ExceptionRepository(client);",
  "const exceptionRepo = RepositoryFactory.getExceptionRepository(client);"
);
fs.writeFileSync('src/services/ServiceFactory.ts', sf);

// 7. Update AiWorkerService.ts
let aws = fs.readFileSync('src/services/impl/AiWorkerService.ts', 'utf8');
aws = aws.replace(
  "// Inline interfaces to avoid importing from connectors/supabase\ninterface IIncidentHistoryRepository {\n  getHistoriesByIncidentIds(incidentIds: string[]): Promise<Map<string, any[]>>;\n}\n\ninterface IExceptionRepository {\n  getActiveExceptionOrderCodes(cutoffDate: string): Promise<Set<string>>;\n}",
  'import type { IIncidentHistoryRepository } from "../../repositories/interfaces/IIncidentHistoryRepository";\nimport type { IExceptionRepository } from "../../repositories/interfaces/IExceptionRepository";'
);
fs.writeFileSync('src/services/impl/AiWorkerService.ts', aws);

// 8. Update sync-rillnet.ts
let sr = fs.readFileSync('src/jobs/sync-rillnet.ts', 'utf8');
sr = sr.replace(
  "IncidentHistoryRepository,",
  ""
);
sr = sr.replace(
  "const historyRepo = new IncidentHistoryRepository(dbClient);",
  "const historyRepo = RepositoryFactory.getIncidentHistoryRepository(dbClient);"
);
fs.writeFileSync('src/jobs/sync-rillnet.ts', sr);

// 9. Fix sync-runs debug route
try {
  let srDebug = fs.readFileSync('src/app/api/debug/sync-runs/route.ts', 'utf8');
  if (srDebug.includes('IncidentHistoryRepository')) {
    srDebug = srDebug.replace(/IncidentHistoryRepository/g, 'SupabaseIncidentHistoryRepository');
    srDebug = srDebug.replace('import { createAdminClient, SupabaseIncidentHistoryRepository } from "@/connectors/supabase";', 'import { createAdminClient } from "@/connectors/supabase";\nimport { RepositoryFactory } from "@/repositories/RepositoryFactory";');
    srDebug = srDebug.replace('new SupabaseIncidentHistoryRepository(client)', 'RepositoryFactory.getIncidentHistoryRepository(client)');
    fs.writeFileSync('src/app/api/debug/sync-runs/route.ts', srDebug);
  }
} catch (e) {}

// 10. Fix ai-worker.test.ts
let awTest = fs.readFileSync('src/__tests__/ai-worker.test.ts', 'utf8');
awTest = awTest.replace(
  "import { IncidentHistoryRepository } from \"@/connectors/supabase\";",
  ""
);
fs.writeFileSync('src/__tests__/ai-worker.test.ts', awTest);

