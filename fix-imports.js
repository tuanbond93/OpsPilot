const fs = require('fs');

function replaceInFile(pathStr, replacer) {
  if (fs.existsSync(pathStr)) {
    let c = fs.readFileSync(pathStr, 'utf8');
    c = replacer(c);
    fs.writeFileSync(pathStr, c);
  }
}

replaceInFile('src/app/api/debug/incidents/[incidentId]/history/route.ts', c => {
  c = c.replace(/IncidentHistoryRepository,?/g, '');
  if (!c.includes('RepositoryFactory')) {
    c = c.replace('import { createAdminClient', 'import { RepositoryFactory } from "@/repositories/RepositoryFactory";\nimport { createAdminClient');
  }
  c = c.replace(/new IncidentHistoryRepository\([^)]*\)/g, 'RepositoryFactory.getIncidentHistoryRepository(dbClient)');
  c = c.replace(/\(h\) =>/g, '(h: any) =>');
  return c;
});

replaceInFile('src/app/api/debug/planner/[incidentId]/generate/route.ts', c => {
  c = c.replace(/IncidentHistoryRepository,?/g, '');
  c = c.replace(/ExceptionRepository,?/g, '');
  if (!c.includes('RepositoryFactory')) {
    c = c.replace('import { createAdminClient', 'import { RepositoryFactory } from "@/repositories/RepositoryFactory";\nimport { createAdminClient');
  }
  c = c.replace(/new IncidentHistoryRepository\([^)]*\)/g, 'RepositoryFactory.getIncidentHistoryRepository(dbClient)');
  c = c.replace(/new ExceptionRepository\([^)]*\)/g, 'RepositoryFactory.getExceptionRepository(dbClient)');
  return c;
});

replaceInFile('src/app/api/debug/rootcause/[incidentId]/route.ts', c => {
  c = c.replace(/IncidentHistoryRepository,?/g, '');
  if (!c.includes('RepositoryFactory')) {
    c = c.replace('import { createAdminClient', 'import { RepositoryFactory } from "@/repositories/RepositoryFactory";\nimport { createAdminClient');
  }
  c = c.replace(/new IncidentHistoryRepository\([^)]*\)/g, 'RepositoryFactory.getIncidentHistoryRepository(dbClient)');
  return c;
});

replaceInFile('src/jobs/sync-rillnet.ts', c => {
  c = c.replace(/ExceptionRepository,?/g, '');
  c = c.replace(/export type SyncRillnetDependencies = {[^}]+};/s, (match) => {
    return match.replace(/IncidentHistoryRepository/g, 'any');
  });
  return c;
});

