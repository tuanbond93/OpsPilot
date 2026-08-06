const fs = require('fs');

let c = fs.readFileSync('src/__tests__/ai-worker.test.ts', 'utf8');

const importFactory = `import { ServiceFactory } from "../services/ServiceFactory";\n`;
if (!c.includes('import { ServiceFactory }')) {
  c = c.replace('import { AiAnalysisWorker } from "../jobs/ai-analysis-worker";', importFactory + 'import { AiAnalysisWorker } from "../jobs/ai-analysis-worker";');
}

const archTest = `
  it("6. Architecture Validation: delegates to AiWorkerService via ServiceFactory", async () => {
    const worker = new AiAnalysisWorker();
    const getAiWorkerServiceSpy = vi.spyOn(ServiceFactory, 'getAiWorkerService');
    
    // Attempt processing (it will mock or fail, doesn't matter for architecture spy)
    await worker.processPendingJobs("test-arch-worker", 1);
    
    expect(getAiWorkerServiceSpy).toHaveBeenCalled();
    getAiWorkerServiceSpy.mockRestore();
  });
`;

c = c.replace('});\n', archTest + '});\n');
fs.writeFileSync('src/__tests__/ai-worker.test.ts', c);
