const fs = require('fs');

let sf = fs.readFileSync('src/services/ServiceFactory.ts', 'utf8');

const importsToAdd = `
import type { INotificationService } from "./interfaces/INotificationService";
import { NotificationService } from "./impl/NotificationService";
import { ActionQueue } from "@/engine/action-queue";
import { ConsoleProvider } from "@/notifications/providers/console";
import { TelegramProvider } from "@/notifications/providers/telegram";
`;

if (!sf.includes('INotificationService')) {
  sf = sf.replace('import { DashboardService }', importsToAdd + 'import { DashboardService }');
}

const methodToAdd = `
  public static getNotificationService(client?: SupabaseClient): INotificationService {
    const queue = new ActionQueue(client);
    const followupRepo = client ? RepositoryFactory.getFollowupRepository(client) : null;
    const providers = [new ConsoleProvider(), new TelegramProvider()];
    return new NotificationService(queue, followupRepo, providers);
  }
`;

if (!sf.includes('getNotificationService')) {
  sf = sf.replace(/public static getDashboardService/g, methodToAdd + '  public static getDashboardService');
}

fs.writeFileSync('src/services/ServiceFactory.ts', sf);

// Also fix test: new NotificationService(queue) -> new NotificationService(queue, null)
let t = fs.readFileSync('src/__tests__/notifications.test.ts', 'utf8');
t = t.replace(/new NotificationService\(([^,]+)\)/g, 'new NotificationService($1, null)');
t = t.replace(/dispatcher\.registerProvider/g, '((dispatcher as any).providers || dispatcher).registerProvider');
// Wait, we don't have registerProvider on NotificationService. It's expecting them to be injected via constructor.
// But the tests use `dispatcher.registerProvider(...)`. I should expose a `registerProvider` method just for tests or update tests to pass them in constructor.
