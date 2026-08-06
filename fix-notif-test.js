const fs = require('fs');

let t = fs.readFileSync('src/__tests__/notifications.test.ts', 'utf8');

t = t.replace(/import \{ NotificationDispatcher \} from "\.\.\/notifications";\r?\n/, 'import { NotificationService } from "@/services/impl/NotificationService";\n');

// They might have been importing it from "@/notifications"
t = t.replace(/import \{ NotificationDispatcher \} from "@\/notifications";\r?\n/, 'import { NotificationService } from "@/services/impl/NotificationService";\n');

t = t.replace(/new NotificationDispatcher\(([^,)]+)\)/g, 'new NotificationService($1, null)');
t = t.replace(/new NotificationDispatcher\(([^,]+),\s*([^)]+)\)/g, 'new NotificationService($1, $2)');
t = t.replace(/dispatcher\.dispatchPendingActions/g, 'dispatcher.dispatchPending');

// Fix the spy logic - wait, ServiceFactory might not have getNotificationService defined in the test file scope if it's imported from somewhere else?
// Let's check ServiceFactory import
if (!t.includes('import { ServiceFactory }')) {
  t = 'import { ServiceFactory } from "@/services/ServiceFactory";\n' + t;
}

// "Error: The property getNotificationService is not defined on the function"
// Oh, the ServiceFactory wasn't exported as an object with getNotificationService? Wait, ServiceFactory is a class with static methods!
// Oh, `vi.spyOn(ServiceFactory, 'getNotificationService')` should work if getNotificationService is a method. Wait, did I add it?
// Let's check ServiceFactory in src/services/ServiceFactory.ts

fs.writeFileSync('src/__tests__/notifications.test.ts', t);
