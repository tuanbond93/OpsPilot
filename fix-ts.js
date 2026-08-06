const fs = require('fs');

// 1. Fix SupabaseDashboardRepository executeQuery -> executeMany
let rep = fs.readFileSync('src/repositories/supabase/SupabaseDashboardRepository.ts', 'utf8');
rep = rep.replace(/this\.executeQuery\(\(\) => /g, 'this.executeMany(');
rep = rep.replace(/, "[^"]*"\);/g, ');');
fs.writeFileSync('src/repositories/supabase/SupabaseDashboardRepository.ts', rep);

// 2. Fix DashboardService imports
let srv = fs.readFileSync('src/services/impl/DashboardService.ts', 'utf8');
srv = srv.replace('../../../integrations/health', '../../integrations/health');
srv = srv.replace('../../../integrations/startup-validator', '../../integrations/startup-validator');
fs.writeFileSync('src/services/impl/DashboardService.ts', srv);

// 3. Fix route.ts typing
let rte = fs.readFileSync('src/app/api/dashboard/route.ts', 'utf8');
rte = rte.replace('let dbClient = null;', 'let dbClient: any = null;');
fs.writeFileSync('src/app/api/dashboard/route.ts', rte);
