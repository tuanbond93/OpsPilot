const fs = require('fs');

let content = fs.readFileSync('src/__tests__/dashboard.test.ts', 'utf8');

// Add import for ServiceFactory
content = content.replace(
  'import { GET } from "../app/api/dashboard/route";',
  'import { GET } from "../app/api/dashboard/route";\nimport { ServiceFactory } from "../services/ServiceFactory";'
);

// Add test to assert ServiceFactory is used
const testStr = `
  it("5. Route delegates to DashboardService", async () => {
    const spy = vi.spyOn(ServiceFactory, "getDashboardService");
    const req = new Request("http://localhost:3000/api/dashboard");
    await GET(req);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
`;

content = content.replace('});\n', testStr + '});\n');

fs.writeFileSync('src/__tests__/dashboard.test.ts', content);
