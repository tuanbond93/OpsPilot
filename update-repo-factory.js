const fs = require('fs');
const content = fs.readFileSync('src/repositories/RepositoryFactory.ts', 'utf8');

const importsToAdd = 
import type { IDashboardRepository } from "./interfaces/IDashboardRepository";
import { SupabaseDashboardRepository } from "./supabase/SupabaseDashboardRepository";
import { MockDashboardRepository } from "./mock/MockDashboardRepository";
;

let newContent = content.replace(
  'import { MockAiJobRepository } from "./mock/MockAiJobRepository";',
  'import { MockAiJobRepository } from "./mock/MockAiJobRepository";\n' + importsToAdd
);

newContent = newContent.replace(
  'private static warehouseRepo: IWarehouseRepository | null = null;',
  'private static warehouseRepo: IWarehouseRepository | null = null;\n  private static dashboardRepo: IDashboardRepository | null = null;'
);

newContent = newContent.replace(
  'static registerWarehouseRepository(repo: IWarehouseRepository): void {',
  'static registerDashboardRepository(repo: IDashboardRepository): void {\n    this.dashboardRepo = repo;\n  }\n\n  static registerWarehouseRepository(repo: IWarehouseRepository): void {'
);

const getDashboardStr = 
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
;

newContent = newContent.replace(
  'static getWarehouseRepository(): IWarehouseRepository {',
  getDashboardStr + '\n  static getWarehouseRepository(): IWarehouseRepository {'
);

newContent = newContent.replace(
  'this.warehouseRepo = null;',
  'this.warehouseRepo = null;\n    this.dashboardRepo = null;'
);

fs.writeFileSync('src/repositories/RepositoryFactory.ts', newContent);
