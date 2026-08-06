const fs = require('fs');

let t = fs.readFileSync('src/__tests__/notifications.test.ts', 'utf8');

// The architecture test currently looks like this because I deleted the execution line:
/*
    // Run the job
    
    expect(getNotificationServiceSpy).toHaveBeenCalled();
    expect(result.summary).toBeDefined();
*/

t = t.replace(/\/\/ Run the job\s+expect\(getNotificationServiceSpy\)/, 
  '// Run the job\n    const result = await runNotificationDispatcherJob("test-worker");\n    expect(getNotificationServiceSpy)');

fs.writeFileSync('src/__tests__/notifications.test.ts', t);
