const fs = require('fs');

let c = fs.readFileSync('src/__tests__/ai-worker.test.ts', 'utf8');

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

c = c.replace(archTest, ''); // remove it from where it was
c = c.replace(/}\);\s*$/g, ''); // remove last `});`

c = c + archTest + '\n});\n';

fs.writeFileSync('src/__tests__/ai-worker.test.ts', c);
