const fs = require('fs');
let content = fs.readFileSync('src/__tests__/yba-pilot-acceptance.test.ts', 'utf8');
content = content.replace(/, leads: \[\]/g, '');
fs.writeFileSync('src/__tests__/yba-pilot-acceptance.test.ts', content);
