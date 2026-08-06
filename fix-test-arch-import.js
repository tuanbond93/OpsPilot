const fs = require('fs');
let t = fs.readFileSync('src/__tests__/notifications.test.ts', 'utf8');

t = t.replace(/\/\/ We mock ServiceFactory\.getNotificationService/, 
  'const { runNotificationDispatcherJob } = await import("@/jobs/dispatch-notifications");\n    // We mock ServiceFactory.getNotificationService');

fs.writeFileSync('src/__tests__/notifications.test.ts', t);
