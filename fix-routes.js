const fs = require('fs');

function fixConfirmRoute() {
  let c = fs.readFileSync('src/app/api/debug/actions/[id]/confirm/route.ts', 'utf8');
  c = c.replace(/import \{ NotificationDispatcher \} from "@\/notifications";\r?\n/, 'import { ServiceFactory } from "@/services/ServiceFactory";\n');
  
  c = c.replace(/const actionQueue = new ActionQueue\(dbClient\);\s+const followupRepo = RepositoryFactory\.getFollowupRepository\(dbClient\);\s+const dispatcher = new NotificationDispatcher\(actionQueue, followupRepo\);\s+await dispatcher\.handleFollowupStateConfirmation\(updatedAction, "manual_debug"\);/, 
    `const notifService = ServiceFactory.getNotificationService(dbClient);\n    // We need to call handleFollowupStateConfirmation which was made private.
    // Wait, the debug route manually confirms state! Let's expose it or ignore it.
    await (notifService as any).handleFollowupStateConfirmation(updatedAction, "manual_debug");`);
  fs.writeFileSync('src/app/api/debug/actions/[id]/confirm/route.ts', c);
}

function fixProvidersRoute() {
  let c = fs.readFileSync('src/app/api/debug/providers/route.ts', 'utf8');
  c = c.replace(/import \{ NotificationDispatcher \} from "@\/notifications";\r?\n/, 'import { ServiceFactory } from "@/services/ServiceFactory";\n');
  
  c = c.replace(/const dispatcher = new NotificationDispatcher\([^)]*\);/, 'const notifService = ServiceFactory.getNotificationService();');
  // providers route does `await dispatcher.getProvidersHealth()` - I didn't migrate this!
  // I need to add getProvidersHealth to NotificationService.
  c = c.replace(/dispatcher\.getProvidersHealth\(\)/, '(notifService as any).getProvidersHealth()');
  fs.writeFileSync('src/app/api/debug/providers/route.ts', c);
}

function fixService() {
  let c = fs.readFileSync('src/services/impl/NotificationService.ts', 'utf8');
  // make handleFollowupStateConfirmation public
  c = c.replace(/private async handleFollowupStateConfirmation/, 'async handleFollowupStateConfirmation');
  
  // add getProvidersHealth
  const healthCode = `
  async getProvidersHealth(): Promise<any[]> {
    const healthList: any[] = [];
    for (const provider of this.providers.values()) {
      try {
        const h = await provider.health();
        healthList.push(h);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        healthList.push({
          name: provider.name(),
          status: "Offline",
          details: \`Health check error: \${msg}\`,
        });
      }
    }
    return healthList;
  }
  `;
  
  if (!c.includes('getProvidersHealth')) {
    c = c.replace('getProvider(name: string): NotificationProvider {', healthCode + '\n  getProvider(name: string): NotificationProvider {');
  }
  
  fs.writeFileSync('src/services/impl/NotificationService.ts', c);
}

fixConfirmRoute();
fixProvidersRoute();
fixService();

