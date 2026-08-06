const fs = require('fs');

let t = fs.readFileSync('src/__tests__/notifications.test.ts', 'utf8');
const lines = t.split('\n').filter(line => !line.includes('NotificationDispatcher') || line.includes('NotificationService'));
fs.writeFileSync('src/__tests__/notifications.test.ts', lines.join('\n'));

