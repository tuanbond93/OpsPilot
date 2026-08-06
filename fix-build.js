const fs = require('fs');

// 1. Fix NotificationService result undefined
let ns = fs.readFileSync('src/services/impl/NotificationService.ts', 'utf8');
ns = ns.replace(/let result;/g, 'let result: any;');
fs.writeFileSync('src/services/impl/NotificationService.ts', ns);

// 2. Fix route
let route = fs.readFileSync('src/app/api/debug/actions/[id]/confirm/route.ts', 'utf8');
route = route.replace(/const dispatcher = new NotificationDispatcher\(queue, followupRepo\);\r?\n\s+if \(updated\) \{\r?\n\s+await dispatcher\.handleFollowupStateConfirmation\(updated, confirmedBy\);\r?\n\s+\}/g, 
  `const notifService = ServiceFactory.getNotificationService();\n    if (updated) {\n      await (notifService as any).handleFollowupStateConfirmation(updated, confirmedBy);\n    }`);
fs.writeFileSync('src/app/api/debug/actions/[id]/confirm/route.ts', route);

// 3. Fix test import
let t = fs.readFileSync('src/__tests__/notifications.test.ts', 'utf8');
t = t.replace(/import \{ NotificationDispatcher \} from "\.\.\/notifications";\r?\n?/g, '');
fs.writeFileSync('src/__tests__/notifications.test.ts', t);
