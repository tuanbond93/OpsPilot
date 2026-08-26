import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  ActionPlannerAgent,
  buildPlannerContext,
  calculateConfidence,
  calculateNextReview,
  computeCanonicalContextHash,
  getAllowedRecommendationTypes,
  getAllowedTargetRoles,
  getBlockedOptions,
} from "../agents/action-planner";
import { MockPlannerRepository } from "@/repositories/mock/MockPlannerRepository";
import type { IncidentRow, IncidentHistoryRow, FollowupCaseRow, OrderExceptionRow } from "@/connectors/supabase";
import type { NotificationActionRow } from "../engine/action-queue";
import type { RootCauseResult } from "../agents/root-cause/schema";

describe("Sprint 6 Phase 2 Final Hardened: Action Planner Tests", () => {
  let mockRepo: MockPlannerRepository;

  const mockIncident: IncidentRow = {
    id: "123e4567-e89b-12d3-a456-426614174000",
    incident_key: "21160000:KHO_TAN_BINH",
    warehouse_id: "21160000",
    warehouse_name: "Kho Tân Bình",
    reason_code: "CUSTOMER_APPOINTMENT",
    reason_name: "Hẹn giờ giao lại",
    status: "open",
    priority_score: 85,
    first_detected_at: "2026-08-05T08:00:00Z",
    last_detected_at: "2026-08-05T12:00:00Z",
  };

  const mockHistoryRows: IncidentHistoryRow[] = [
    {
      incident_id: mockIncident.id,
      sync_run_id: "sync-1",
      recorded_at: "2026-08-05T12:00:00Z",
      affected_order_count: 120,
      average_age_hours: 36,
      maximum_age_hours: 50,
      priority_score: 85,
      sample_order_codes: ["ORD1", "ORD2"],
    },
    {
      incident_id: mockIncident.id,
      sync_run_id: "sync-0",
      recorded_at: "2026-08-05T10:00:00Z",
      affected_order_count: 100,
      average_age_hours: 30,
      maximum_age_hours: 44,
      priority_score: 80,
      sample_order_codes: ["ORD1"],
    },
  ];

  const mockRootCauseResult: RootCauseResult = {
    summary: "Mock Root Cause Summary",
    assessment: { status: "worsening", explanation: "Backlog increasing" },
    causes: [{ title: "Congestion", confidence: 90, evidenceCodes: ["CURRENT_AFFECTED_COUNT"], explanation: "" }],
    investigationSteps: [],
    risk: { score: 85, level: "critical", factors: [] },
    confidence: 90,
    limitations: [],
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    mockRepo = new MockPlannerRepository();
  });

  // 1. Uniqueness: Concurrent identical generation creates one DRAFT
  it("1. Concurrent identical generation creates one active DRAFT run", async () => {
    const ctx = buildPlannerContext(mockIncident, mockHistoryRows);

    const run1 = await mockRepo.createPlannerRun({
      incident_id: mockIncident.id,
      status: "DRAFT",
      context_hash: ctx.contextHash,
      prompt_version: 1,
    });

    const run2 = await mockRepo.createPlannerRun({
      incident_id: mockIncident.id,
      status: "DRAFT",
      context_hash: ctx.contextHash,
      prompt_version: 1,
    });

    expect(run2.id).toBe(run1.id);
  });

  // 2. Uniqueness: APPROVED run can be force-regenerated and draft approved later
  it("2. APPROVED run can be force-regenerated, creating new DRAFT that can become APPROVED", async () => {
    const ctx = buildPlannerContext(mockIncident, mockHistoryRows);

    const draft1 = await mockRepo.createPlannerRun({
      incident_id: mockIncident.id,
      status: "DRAFT",
      context_hash: ctx.contextHash,
      prompt_version: 1,
    });

    await mockRepo.updatePlannerRunStatus(draft1.id, "APPROVED", "operator@ops.vn");
    const approved1 = await mockRepo.getPlannerRunById(draft1.id);
    expect(approved1?.status).toBe("APPROVED");

    const agent = new ActionPlannerAgent(mockRepo);
    const regenRes = await agent.analyzeIncident({
      incident: mockIncident,
      historyRows: mockHistoryRows,
      options: { forceRegenerate: true, requestedBy: "lead@ops.vn" },
    });

    expect(regenRes.cached).toBe(false);
    expect(regenRes.runId).not.toBe(draft1.id);

    await mockRepo.updatePlannerRunStatus(regenRes.runId!, "APPROVED", "manager@ops.vn");
    const approved2 = await mockRepo.getPlannerRunById(regenRes.runId!);
    expect(approved2?.status).toBe("APPROVED");

    const allRuns = await mockRepo.getAllPlannerRuns();
    const approvedRuns = allRuns.filter((r) => r.status === "APPROVED");
    expect(approvedRuns.length).toBe(2);
  });

  // 3. Uniqueness: Multiple REJECTED or EXPIRED runs do not violate uniqueness
  it("3. Multiple historical REJECTED or EXPIRED runs do not violate uniqueness", async () => {
    const ctx = buildPlannerContext(mockIncident, mockHistoryRows);

    const run1 = await mockRepo.createPlannerRun({
      id: "prun-1",
      incident_id: mockIncident.id,
      status: "REJECTED",
      context_hash: ctx.contextHash,
      prompt_version: 1,
    });

    const run2 = await mockRepo.createPlannerRun({
      id: "prun-2",
      incident_id: mockIncident.id,
      status: "REJECTED",
      context_hash: ctx.contextHash,
      prompt_version: 1,
    });

    const run3 = await mockRepo.createPlannerRun({
      id: "prun-3",
      incident_id: mockIncident.id,
      status: "EXPIRED",
      context_hash: ctx.contextHash,
      prompt_version: 1,
    });

    expect(run1.id).not.toBe(run2.id);
    expect(run2.id).not.toBe(run3.id);

    const allRuns = await mockRepo.getAllPlannerRuns();
    expect(allRuns.filter((r) => r.status === "REJECTED").length).toBe(2);
    expect(allRuns.filter((r) => r.status === "EXPIRED").length).toBe(1);
  });

  // 4. Governance: Disallowed LOGISTICS_EXECUTIVE combinations
  it("4. LOGISTICS_EXECUTIVE is disallowed for all non-escalation recommendation types", () => {
    const typesDisallowed: any[] = [
      "PRIORITIZE_OLD_ORDERS",
      "VERIFY_EXCEPTION",
      "REVIEW_ASSIGNMENT",
      "CONTACT_WAREHOUSE",
      "CONTINUE_MONITORING",
      "NO_ACTION",
    ];

    for (const recType of typesDisallowed) {
      const roles = getAllowedTargetRoles("CUSTOMER_APPOINTMENT", recType, "ESCALATED", "critical");
      expect(roles).not.toContain("LOGISTICS_EXECUTIVE");
    }
  });

  // 5. Governance: LOGISTICS_EXECUTIVE allowed ONLY when PREPARE_ESCALATION + ESCALATED + critical risk
  it("5. LOGISTICS_EXECUTIVE is allowed ONLY for PREPARE_ESCALATION when followupState is ESCALATED and risk is critical", () => {
    const rolesValid = getAllowedTargetRoles("CUSTOMER_APPOINTMENT", "PREPARE_ESCALATION", "ESCALATED", "critical", true);
    expect(rolesValid).toContain("LOGISTICS_EXECUTIVE");

    const rolesNotCritical = getAllowedTargetRoles("CUSTOMER_APPOINTMENT", "PREPARE_ESCALATION", "ESCALATED", "high", true);
    expect(rolesNotCritical).not.toContain("LOGISTICS_EXECUTIVE");

    const rolesNotEscalated = getAllowedTargetRoles("CUSTOMER_APPOINTMENT", "PREPARE_ESCALATION", "FIRST_PUSH_SENT", "critical", true);
    expect(rolesNotEscalated).not.toContain("LOGISTICS_EXECUTIVE");

    const rolesPolicyDisabled = getAllowedTargetRoles("CUSTOMER_APPOINTMENT", "PREPARE_ESCALATION", "ESCALATED", "critical", false);
    expect(rolesPolicyDisabled).not.toContain("LOGISTICS_EXECUTIVE");
  });

  // 6. Context Hash: Exception order membership change changes hash
  it("6. Exception order membership change changes context hash", () => {
    const exc1: OrderExceptionRow[] = [
      { id: "e1", order_code: "ORD100", reason_code: "CUSTOMER_APPOINTMENT", reason_name: "Hẹn" },
    ];
    const exc2: OrderExceptionRow[] = [
      { id: "e2", order_code: "ORD200", reason_code: "CUSTOMER_APPOINTMENT", reason_name: "Hẹn" },
    ];

    const hash1 = computeCanonicalContextHash(mockIncident, mockHistoryRows, null, null, exc1);
    const hash2 = computeCanonicalContextHash(mockIncident, mockHistoryRows, null, null, exc2);

    expect(hash1).not.toBe(hash2);
  });

  // 7. Context Hash: Action delivery status change changes hash
  it("7. Action delivery status change changes context hash", () => {
    const act1: NotificationActionRow[] = [
      {
        id: "act-1",
        action_type: "FIRST_PUSH",
        provider: "console",
        target_type: "WAREHOUSE",
        payload: {},
        status: "PROCESSING",
        priority: "high",
        retry_count: 0,
        max_retry: 3,
        scheduled_at: "2026-08-05T12:00:00Z",
      },
    ];

    const act2: NotificationActionRow[] = [
      {
        ...act1[0],
        status: "SENT",
        outcome: "DELIVERED",
        processed_at: "2026-08-05T12:01:00Z",
      },
    ];

    const hash1 = computeCanonicalContextHash(mockIncident, mockHistoryRows, null, null, [], act1);
    const hash2 = computeCanonicalContextHash(mockIncident, mockHistoryRows, null, null, [], act2);

    expect(hash1).not.toBe(hash2);
  });

  // 8. Context Hash: Root Cause prompt version & Planner policy version change changes hash
  it("8. Root Cause prompt version and Planner policy version changes context hash", () => {
    const hashV1 = computeCanonicalContextHash(mockIncident, mockHistoryRows, mockRootCauseResult, null, [], [], [], [], [], '1', '1', '1', '1', '2');
    const hashV2 = computeCanonicalContextHash(mockIncident, mockHistoryRows, mockRootCauseResult, null, [], [], [], [], [], '1', '2', '1', '1', '2');
    const hashRcVer3 = computeCanonicalContextHash(mockIncident, mockHistoryRows, mockRootCauseResult, null, [], [], [], [], [], '1', '1', '1', '1', '3');

    expect(hashV1).not.toBe(hashV2);
    expect(hashV1).not.toBe(hashRcVer3);
  });

  // 9. Context Hash: Irrelevant display-only text does NOT change hash
  it("9. Irrelevant display-only notes/warehouse display names do NOT change context hash", () => {
    const inc1 = { ...mockIncident, warehouse_name: "Kho Tân Bình 1" };
    const inc2 = { ...mockIncident, warehouse_name: "Kho Tân Bình Display Name Change" };

    const hash1 = computeCanonicalContextHash(inc1, mockHistoryRows);
    const hash2 = computeCanonicalContextHash(inc2, mockHistoryRows);

    expect(hash1).toBe(hash2);
  });
});
