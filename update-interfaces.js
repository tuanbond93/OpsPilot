const fs = require('fs');

let c = fs.readFileSync('src/services/interfaces/IAiWorkerService.ts', 'utf8');
c = c.replace(
  'processPendingJobs(): Promise<void>;',
  'processPendingJobs(workerId?: string, maxJobs?: number): Promise<any>;'
);
fs.writeFileSync('src/services/interfaces/IAiWorkerService.ts', c);

let c2 = fs.readFileSync('src/services/impl/NoOpAiWorkerService.ts', 'utf8');
c2 = c2.replace(
  'async processPendingJobs(): Promise<void> {',
  'async processPendingJobs(workerId?: string, maxJobs?: number): Promise<any> {'
);
fs.writeFileSync('src/services/impl/NoOpAiWorkerService.ts', c2);
