import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { actionableApprovalRecommendation, usableApprovalText } from "@/app/_components/approvalContent";

const source = (path: string) => readFileSync(path, "utf8");
const planner = source("src/app/planner/page.tsx");
const dashboard = source("src/app/dashboard/page.tsx");
const copilot = source("src/app/copilot/[incidentId]/page.tsx");
const incident = source("src/app/incidents/[incidentId]/page.tsx");

describe("Website V2 UI acceptance", () => {
  it("keeps the dashboard free of the removed getting-started guide and sends planning links to reviews", () => {
    expect(dashboard).not.toContain("OperatorStartHere");
    expect(dashboard).toContain('href: "/reviews"');
  });

  it("hides parser errors while preserving evidence-backed root causes", () => {
    expect(usableApprovalText("AI response was not valid JSON")).toBeNull();
    expect(usableApprovalText("Kho xác nhận thiếu 12 kiện")).toBe("Kho xác nhận thiếu 12 kiện");
    expect(copilot).toContain("rootCause?.analysis?.causes");
    expect(copilot).toContain("Chưa xác định được nguyên nhân đủ căn cứ.");
  });

  it("blocks generic recommendations and retains actionable instructions", () => {
    expect(actionableApprovalRecommendation("Tiếp tục theo dõi")).toBeNull();
    expect(actionableApprovalRecommendation("Kho xác nhận vị trí hàng trước 15:00")).toBe("Kho xác nhận vị trí hàng trước 15:00");
    expect(copilot).toContain("Chưa có hành động đủ cụ thể để phê duyệt.");
  });

  it("redirects non-admin users and keeps the administrator compatibility view operator-readable", () => {
    expect(planner).toContain('session.role !== "ADMIN"');
    expect(planner).toContain('router.replace("/reviews")');
    expect(planner).toContain("Kế hoạch xử lý");
    expect(planner).toContain("Chưa có hành động đủ cụ thể để thực hiện.");
  });

  it("does not render technical planner labels in the compatibility view", () => {
    for (const forbidden of [
      "EXECUTIVE SUMMARY",
      "RECOMMENDATIONS",
      "PREPARE_ESCALATION",
      "WAREHOUSE_DISPATCHER",
      "Manual Approval Required",
      "Run ID",
      "Confidence",
      "SHADOW",
    ]) {
      expect(planner).not.toContain(forbidden);
    }
    expect(incident).toContain("translateStatus(decision.decisionStatus)");
  });
});
