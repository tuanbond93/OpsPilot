const fs = require('fs');

let content = fs.readFileSync('src/services/ServiceFactory.ts', 'utf8');
content = content.replace(
  'import { NoOpDashboardService } from \'./impl/NoOpDashboardService\';',
  'import { DashboardService } from \'./impl/DashboardService\';'
);

content = content.replace(
  'public static getDashboardService(client?: SupabaseClient): IDashboardService {\n    return new NoOpDashboardService();\n  }',
  'public static getDashboardService(client?: SupabaseClient): IDashboardService {\n    return new DashboardService(\n      RepositoryFactory.getDashboardRepository(client),\n      RepositoryFactory.getAiJobRepository(client),\n      RepositoryFactory.getSyncRunRepository(client)\n    );\n  }'
);
fs.writeFileSync('src/services/ServiceFactory.ts', content);
