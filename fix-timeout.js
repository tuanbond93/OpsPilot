const fs = require('fs');
let t = fs.readFileSync('src/__tests__/notifications.test.ts', 'utf8');

const testCode = `
  it("Architecture Validation: delegates to NotificationService via ServiceFactory", async () => {
    const { runNotificationDispatcherJob } = await import("@/jobs/dispatch-notifications");
    
    // We mock ServiceFactory.getNotificationService to return a NoOp / dummy
    const getNotificationServiceSpy = vi.spyOn(ServiceFactory, 'getNotificationService').mockReturnValue({
      dispatchPending: vi.fn().mockResolvedValue({
        claimedCount: 0,
        sentCount: 0,
        simulatedCount: 0,
        failedCount: 0,
        retriedCount: 0
      })
    } as any);
    
    // We also need to mock createAdminClient if it's imported, but since we mocked getNotificationService, 
    // it will just use whatever client and return our mocked service, avoiding any network calls inside dispatchPending.
    
    // Run the job
    const result = await runNotificationDispatcherJob("test-worker");
    
    expect(getNotificationServiceSpy).toHaveBeenCalled();
    expect(result.summary).toBeDefined();
    getNotificationServiceSpy.mockRestore();
  });
`;

// Replace the old test with the new one
t = t.replace(/it\("Architecture Validation: delegates to NotificationService via ServiceFactory"[\s\S]*?getNotificationServiceSpy\.mockRestore\(\);\s*\}\);/, testCode.trim());

fs.writeFileSync('src/__tests__/notifications.test.ts', t);
