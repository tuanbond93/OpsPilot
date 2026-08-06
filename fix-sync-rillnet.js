const fs = require('fs');
let sr = fs.readFileSync('src/jobs/sync-rillnet.ts', 'utf8');

if (!sr.includes('import { RepositoryFactory')) {
  sr = sr.replace('import { createAdminClient', 'import { RepositoryFactory } from "@/repositories/RepositoryFactory";\nimport { createAdminClient');
}
if (!sr.includes('import type { IIncidentHistoryRepository')) {
  sr = sr.replace('import type { IIncidentRepository', 'import type { IIncidentHistoryRepository } from "@/repositories/interfaces/IIncidentHistoryRepository";\nimport type { IExceptionRepository } from "@/repositories/interfaces/IExceptionRepository";\nimport type { IIncidentRepository');
}

sr = sr.replace(/let incidentHistoryRepo: IncidentHistoryRepository \| null = null;/g, 'let incidentHistoryRepo: IIncidentHistoryRepository | null = null;');
sr = sr.replace(/let exceptionRepo:  \| null = null;/g, 'let exceptionRepo: IExceptionRepository | null = null;');
sr = sr.replace(/incidentHistoryRepo = new IncidentHistoryRepository\(dbClient\);/g, 'incidentHistoryRepo = RepositoryFactory.getIncidentHistoryRepository(dbClient);');
sr = sr.replace(/exceptionRepo = new \(dbClient\);/g, 'exceptionRepo = RepositoryFactory.getExceptionRepository(dbClient);');

fs.writeFileSync('src/jobs/sync-rillnet.ts', sr);
