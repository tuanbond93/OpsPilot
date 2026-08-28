const fs = require('fs');
let content = fs.readFileSync('src/__tests__/yba-pilot-acceptance.test.ts', 'utf8');
content = content.replace(
  'mockSupabase.select.mockResolvedValue({ data: null });',
  '// mockSupabase.select...'
);
fs.writeFileSync('src/__tests__/yba-pilot-acceptance.test.ts', content);
