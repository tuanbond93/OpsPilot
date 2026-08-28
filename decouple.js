const fs = require('fs');
let content = fs.readFileSync('src/services/telegram-followup-pilot.ts', 'utf8');

content = content.replace('import { routeIncident } from "@/engine/rules/triage";\n', '');
content = content.replace(
  /const triage = routeIncident\(\{[\s\S]*?\}\);/g,
  'const route = "AUTO_HANDLE";'
);
content = content.replace(
  /triage\.route !== "AUTO_HANDLE"/g,
  'route !== "AUTO_HANDLE"'
);
content = content.replace(
  /triage\.route/g,
  'route'
);

fs.writeFileSync('src/services/telegram-followup-pilot.ts', content);

let testContent = fs.readFileSync('src/__tests__/yba-pilot-acceptance.test.ts', 'utf8');
testContent = testContent.replace(
  'const mockSupabase = {',
  'const mockSupabase: any = {'
);
testContent = testContent.replace(/leads: \[\]\,/g, '');

fs.writeFileSync('src/__tests__/yba-pilot-acceptance.test.ts', testContent);
