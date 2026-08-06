const fs = require('fs');
let idx = fs.readFileSync('src/notifications/index.ts', 'utf8');
idx = idx.replace(/export \* from "\.\/dispatcher";\r?\n?/, '');
fs.writeFileSync('src/notifications/index.ts', idx);

try { fs.unlinkSync('src/notifications/dispatcher.ts'); } catch (e) {}

// Add test
let t = fs.readFileSync('src/__tests__/notifications.test.ts', 'utf8');
if (!t.includes('Architecture Validation')) {
  // We need to inject the architecture validation test
  const importToAdd = `import { ServiceFactory } from "@/services/ServiceFactory";\n`;
  if (!t.includes('import { ServiceFactory }')) {
    t = importToAdd + t;
  }
  
  const testCode = `
  it("Architecture Validation: delegates to NotificationService via ServiceFactory", async () => {
    const { runNotificationDispatcherJob } = await import("@/jobs/dispatch-notifications");
    const getNotificationServiceSpy = vi.spyOn(ServiceFactory, 'getNotificationService');
    
    // Run the job
    const result = await runNotificationDispatcherJob("test-worker");
    
    expect(getNotificationServiceSpy).toHaveBeenCalled();
    expect(result.summary).toBeDefined();
    getNotificationServiceSpy.mockRestore();
  });
`;
  t = t.replace('});', '});\n' + testCode);
  fs.writeFileSync('src/__tests__/notifications.test.ts', t);
}
