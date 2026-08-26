import { evaluateRootCauseSuite, evaluatePlannerSuite } from "./evaluator";
import { ServiceFactory } from "@/services/ServiceFactory";

async function main() {
  console.log("==================================================");
  console.log("      OpsPilot Synthetic Evaluation (Golden Dataset)");
  console.log("==================================================\n");

  console.log("Evaluating Root Cause Agent...");
  const rootCauseSuite = await evaluateRootCauseSuite();
  console.log(`RootCause: ${rootCauseSuite.passCount}/${rootCauseSuite.totalCount} PASS (Avg Score: ${rootCauseSuite.averageScore})`);
  for (const res of rootCauseSuite.results) {
    const status = res.passed ? "✓ PASS" : "✗ FAIL";
    console.log(`  [${status}] ${res.id}: ${res.name} (Score: ${res.score})`);
    if (res.differences.length > 0) {
      for (const diff of res.differences) {
        console.log(`      - ${diff.field}: ${diff.message}`);
      }
    }
  }

  console.log("\nEvaluating Action Planner Agent...");
  const plannerSuite = await evaluatePlannerSuite();
  console.log(`Planner:   ${plannerSuite.passCount}/${plannerSuite.totalCount} PASS (Avg Score: ${plannerSuite.averageScore})`);
  for (const res of plannerSuite.results) {
    const status = res.passed ? "✓ PASS" : "✗ FAIL";
    console.log(`  [${status}] ${res.id}: ${res.name} (Score: ${res.score})`);
    if (res.differences.length > 0) {
      for (const diff of res.differences) {
        console.log(`      - ${diff.field}: ${diff.message}`);
      }
    }
  }

  const grandTotal = rootCauseSuite.totalCount + plannerSuite.totalCount;
  const grandPassed = rootCauseSuite.passCount + plannerSuite.passCount;
  const combinedAvg = Math.round((rootCauseSuite.averageScore + plannerSuite.averageScore) / 2);

  console.log("\n==================================================");
  console.log(`SYNTHETIC EVALUATION SUMMARY: ${grandPassed}/${grandTotal} PASSED | Avg Score: ${combinedAvg}`);
  console.log("==================================================");

  console.log("\n==================================================");
  console.log("      OpsPilot Production Human Agreement Evaluation");
  console.log("==================================================");

  try {
    const qualityService = ServiceFactory.getCopilotQualityService();
    const qualityRes = await qualityService.getQualitySummary();
    if (qualityRes.ok && qualityRes.summary) {
      const s = qualityRes.summary;
      console.log(`Production Records Evaluated: ${s.totalEvaluated}`);
      if (s.totalEvaluated === 0) {
        console.log("Production evidence status:  INSUFFICIENT_DATA (human review required)");
        console.log("Overall AI Quality Score:     NOT_EVALUATED");
        console.log("Release Readiness Score:     NOT_EVALUATED");
        console.log("Agreement / calibration:     NOT_EVALUATED");
      } else {
        console.log(`Overall AI Quality Score:     ${s.overallQualityScore}/100`);
        console.log(`Release Readiness Score:     ${s.releaseReadinessScore}/100`);
        console.log(`Weighted Agreement Score:    ${s.agreementMetrics.weightedAgreement}/100`);
        console.log(`Approval Rate:               ${(s.reviewMetrics.approvalRate * 100).toFixed(1)}%`);
        console.log(`Calibration Score:           ${s.confidenceMetrics.calibrationScore}/100`);
        console.log(`Overconfidence Rate:         ${(s.confidenceMetrics.overconfidenceRate * 100).toFixed(1)}%`);
      }
    } else {
      console.log("No production human review records available yet.");
    }
  } catch (err: unknown) {
    console.log("Production evaluation warning:", err instanceof Error ? err.message : String(err));
  }
  console.log("==================================================");

  if (grandPassed < grandTotal) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Evaluation error:", err);
  process.exit(1);
});
