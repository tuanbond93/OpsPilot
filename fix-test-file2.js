const fs = require('fs');
let c = fs.readFileSync('src/__tests__/dashboard.test.ts', 'utf8');

c = c.replace(
  'expect(json.writeControlsEnabled).toBe(false);\n  \n  it("5. Route delegates to DashboardService", async () => {',
  'expect(json.writeControlsEnabled).toBe(false);\n  });\n\n  it("5. Route delegates to DashboardService", async () => {'
);
fs.writeFileSync('src/__tests__/dashboard.test.ts', c);
