const fs = require('fs');

let sf = fs.readFileSync('src/services/ServiceFactory.ts', 'utf8');

if (sf.includes('NoOpNotificationService')) {
  sf = sf.replace(/import \{ NoOpNotificationService \} from "\.\/impl\/NoOpNotificationService";\r?\n?/, '');
  sf = sf.replace(/import type \{ INotificationService \} from "\.\/interfaces\/INotificationService";/, 'import type { INotificationService } from "./interfaces/INotificationService";\nimport { NotificationService } from "./impl/NotificationService";\nimport { ActionQueue } from "@/engine/action-queue";\nimport { ConsoleProvider } from "@/notifications/providers/console";\nimport { TelegramProvider } from "@/notifications/providers/telegram";');
  sf = sf.replace(/public static getNotificationService\(client\?: SupabaseClient\): INotificationService \{\r?\n\s+return new NoOpNotificationService\(\);\r?\n\s+\}/,
  `public static getNotificationService(client?: SupabaseClient): INotificationService {
    const queue = new ActionQueue(client);
    const followupRepo = client ? RepositoryFactory.getFollowupRepository(client) : null;
    const providers = [new ConsoleProvider(), new TelegramProvider()];
    return new NotificationService(queue, followupRepo, providers);
  }`);
  fs.writeFileSync('src/services/ServiceFactory.ts', sf);
}

let job = fs.readFileSync('src/jobs/dispatch-notifications.ts', 'utf8');
job = job.replace(/import \{ ActionQueue \} from "\.\.\/engine\/action-queue";\r?\n/, '');
job = job.replace(/import \{ NotificationDispatcher, type DispatchSummary \} from "\.\.\/notifications";\r?\n/, 'import type { DispatchSummary } from "@/services/interfaces/INotificationService";\nimport { ServiceFactory } from "@/services/ServiceFactory";\n');

job = job.replace(/const actionQueue = new ActionQueue\(dbClient\);\s+const followupRepo = dbClient \? RepositoryFactory\.getFollowupRepository\(dbClient\) : null;\s+const dispatcher = new NotificationDispatcher\(actionQueue, followupRepo, workerId\);\s+const summary = await dispatcher\.dispatchPendingActions\(referenceTimeMs\);/,
  `const notifService = ServiceFactory.getNotificationService(dbClient);\n    const summary = await notifService.dispatchPending(workerId, referenceTimeMs);`);

fs.writeFileSync('src/jobs/dispatch-notifications.ts', job);

let api = fs.readFileSync('src/app/api/cron/dispatch-notifications/route.ts', 'utf8');
if (api.includes('NotificationDispatcher')) {
  // It shouldn't if it calls the job...
}
