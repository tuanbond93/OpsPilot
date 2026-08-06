const fs = require('fs');
let c = fs.readFileSync('src/__tests__/dashboard.test.ts', 'utf8');

const testStr = `
  it("5. Route delegates to DashboardService", async () => {
    const spy = vi.spyOn(ServiceFactory, "getDashboardService");
    const req = new Request("http://localhost:3000/api/dashboard");
    await GET(req);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
`;

c = c.replace(testStr, ''); // remove from wherever it was inserted
c = c.replace(/}\);\n$/g, ''); // remove last line
c = c.replace(/}\);\s*$/g, ''); // just in case

c = c + testStr + '\n});\n';

fs.writeFileSync('src/__tests__/dashboard.test.ts', c);
