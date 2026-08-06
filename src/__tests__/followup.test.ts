import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  evaluateNextState,
  evaluateProgressAssessment,
  FollowupMessageBuilder,
  FollowupEngine,
} from "../engine/followup";
import { DEFAULT_FOLLOWUP_CONFIG } from "../config/followup";
import type { Incident } from "../engine/incident";
import fs from "fs";

describe("Sprint 4.3 Hardened: Follow-up Engine & Action Governance Tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const dummyIncident: Incident = {
    incidentId: "123e4567-e89b-12d3-a456-426614174000",
    incidentKey: "21160000:KHO_TON",
    warehouseId: "21160000",
    warehouseName: "Kho Phú Thọ",
    reasonCode: "KHO_TON",
    reasonName: "Kho tồn",
    status: "open",
    priorityScore: 75,
    firstDetectedAt: "2026-08-05T08:00:00Z",
    lastDetectedAt: "2026-08-05T08:00:00Z",
    affectedOrderCount: 100,
    sampleOrderCodes: ["ORD-1", "ORD-2"],
    averageAgeHours: 36.0,
    maximumAgeHours: 48.0,
    oldestOrderCode: "ORD-1",
  };

  // 1. Progress & Change Sign Semantics: 100 -> 92 gives progressPercent = 8
  it("1. 100 -> 92 gives progressPercent = 8 (positive for reduction/improvement)", () => {
    const { countChangePercent, progressPercent, assessment } = evaluateProgressAssessment(92, 100, 2);
    expect(countChangePercent).toBe(-8); // count decreased by 8%
    expect(progressPercent).toBe(8); // +8% progress!
    expect(assessment).toBe("limited_progress");
  });

  // 2. Progress & Change Sign Semantics: 100 -> 120 gives progressPercent = -20
  it("2. 100 -> 120 gives progressPercent = -20 (negative for regression/worsening)", () => {
    const { countChangePercent, progressPercent, assessment } = evaluateProgressAssessment(120, 100, 2);
    expect(countChangePercent).toBe(20); // count increased by 20%
    expect(progressPercent).toBe(-20); // -20% progress (regression!)
    expect(assessment).toBe("worsening");
  });

  // 3. 100 -> 75 (25% progress) remains active in FOLLOWING_UP, NOT RESOLVED
  it("3. 100 -> 75 (25% progress) remains active in FOLLOWING_UP, NOT RESOLVED", () => {
    const res = evaluateNextState("FIRST_PUSH_SENT", {
      incidentId: dummyIncident.incidentId,
      incidentKey: dummyIncident.incidentKey,
      currentCount: 75,
      baselineCount: 100,
      previousCount: 100,
      countChangePercent: -25,
      progressPercent: 25,
      progressAssessment: "strong_progress",
      incidentDurationHours: 2,
      isIncidentActive: true,
      timeSinceLastActionHours: 2.1,
      timeSinceResolvedHours: 0,
    });

    expect(res.newState).toBe("FOLLOWING_UP"); // Remains active in FOLLOWING_UP!
    expect(res.newState).not.toBe("RESOLVED");
  });

  // 4. 100 -> 0 becomes RESOLVED
  it("4. 100 -> 0 becomes RESOLVED", () => {
    const res = evaluateNextState("FIRST_PUSH_SENT", {
      incidentId: dummyIncident.incidentId,
      incidentKey: dummyIncident.incidentKey,
      currentCount: 0,
      baselineCount: 100,
      previousCount: 100,
      countChangePercent: -100,
      progressPercent: 100,
      progressAssessment: "strong_progress",
      incidentDurationHours: 2,
      isIncidentActive: true,
      timeSinceLastActionHours: 2,
      timeSinceResolvedHours: 0,
    });

    expect(res.newState).toBe("RESOLVED");
    expect(res.eventType).toBe("INCIDENT_RESOLVED");
  });

  // 5. Disappeared incident resolves follow-up case
  it("5. Disappeared incident resolves follow-up case", () => {
    const res = evaluateNextState("FOLLOWING_UP", {
      incidentId: dummyIncident.incidentId,
      incidentKey: dummyIncident.incidentKey,
      currentCount: 0,
      baselineCount: 100,
      previousCount: 100,
      countChangePercent: -100,
      progressPercent: 100,
      progressAssessment: "strong_progress",
      incidentDurationHours: 4,
      isIncidentActive: false, // Disappeared from snapshot
      timeSinceLastActionHours: 4,
      timeSinceResolvedHours: 0,
    });

    expect(res.newState).toBe("RESOLVED");
    expect(res.eventType).toBe("INCIDENT_RESOLVED");
  });

  // 6. New case produces CASE_CREATED and PUSH_REQUESTED
  it("6. New case produces CASE_CREATED and PUSH_REQUESTED", () => {
    const res = evaluateNextState("NEW", {
      incidentId: dummyIncident.incidentId,
      incidentKey: dummyIncident.incidentKey,
      currentCount: 100,
      baselineCount: 100,
      previousCount: 100,
      countChangePercent: 0,
      progressPercent: 0,
      progressAssessment: "no_progress",
      incidentDurationHours: 0,
      isIncidentActive: true,
      timeSinceLastActionHours: 0,
      timeSinceResolvedHours: 0,
    });

    expect(res.newState).toBe("FIRST_PUSH_PENDING");
    expect(res.eventType).toBe("CASE_CREATED");
    expect(res.actionRequestedAt).toBeDefined();
  });

  // 7. Pending push cannot become SENT without confirmation
  it("7. Pending push cannot become SENT without confirmation", () => {
    const unconfirmedRes = evaluateNextState("FIRST_PUSH_PENDING", {
      incidentId: dummyIncident.incidentId,
      incidentKey: dummyIncident.incidentKey,
      currentCount: 100,
      baselineCount: 100,
      previousCount: 100,
      countChangePercent: 0,
      progressPercent: 0,
      progressAssessment: "no_progress",
      incidentDurationHours: 0,
      isIncidentActive: true,
      timeSinceLastActionHours: 1,
      timeSinceResolvedHours: 0,
      isConfirmed: false,
    });

    expect(unconfirmedRes.newState).toBe("FIRST_PUSH_PENDING");

    const confirmedRes = evaluateNextState("FIRST_PUSH_PENDING", {
      incidentId: dummyIncident.incidentId,
      incidentKey: dummyIncident.incidentKey,
      currentCount: 100,
      baselineCount: 100,
      previousCount: 100,
      countChangePercent: 0,
      progressPercent: 0,
      progressAssessment: "no_progress",
      incidentDurationHours: 0,
      isIncidentActive: true,
      timeSinceLastActionHours: 1,
      timeSinceResolvedHours: 0,
      isConfirmed: true,
      confirmedBy: "Dispatcher A",
    });

    expect(confirmedRes.newState).toBe("FIRST_PUSH_SENT");
    expect(confirmedRes.eventType).toBe("PUSH_CONFIRMED");
  });

  // 8. Escalation requires confirmation
  it("8. Escalation requires confirmation", () => {
    const pendingEscalation = evaluateNextState("SECOND_PUSH_SENT", {
      incidentId: dummyIncident.incidentId,
      incidentKey: dummyIncident.incidentKey,
      currentCount: 100,
      baselineCount: 100,
      previousCount: 100,
      countChangePercent: 0,
      progressPercent: 0,
      progressAssessment: "no_progress",
      incidentDurationHours: 6,
      isIncidentActive: true,
      timeSinceLastActionHours: 2.5,
      timeSinceResolvedHours: 0,
    });

    expect(pendingEscalation.newState).toBe("ESCALATION_PENDING");

    const confirmedEscalation = evaluateNextState("ESCALATION_PENDING", {
      incidentId: dummyIncident.incidentId,
      incidentKey: dummyIncident.incidentKey,
      currentCount: 100,
      baselineCount: 100,
      previousCount: 100,
      countChangePercent: 0,
      progressPercent: 0,
      progressAssessment: "no_progress",
      incidentDurationHours: 6,
      isIncidentActive: true,
      timeSinceLastActionHours: 2.5,
      timeSinceResolvedHours: 0,
      isConfirmed: true,
      confirmedBy: "Lead Manager",
    });

    expect(confirmedEscalation.newState).toBe("ESCALATED");
    expect(confirmedEscalation.eventType).toBe("ESCALATION_CONFIRMED");
  });

  // 9. Migration 003 contains no unconditional duplicate CREATE TYPE or CREATE TABLE
  it("9. Migration 003 contains no unconditional duplicate CREATE TYPE or CREATE TABLE", () => {
    const migrationSql = fs.readFileSync("src/database/migrations/003_followup_engine_hardening.sql", "utf-8");
    expect(migrationSql).not.toContain("CREATE TABLE followup_cases"); // Uses ALTER TABLE
    expect(migrationSql).not.toContain("CREATE TYPE followup_state_enum AS ENUM"); // Uses ALTER TYPE ADD VALUE IF NOT EXISTS
    expect(migrationSql).toContain("ADD VALUE IF NOT EXISTS");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS");
  });

  // 10. Sync job performs 1 batch query for history without N+1 loop
  it("10. Sync job performs 1 batch query for history without N+1 loop", () => {
    const syncServiceCode = fs.readFileSync("src/services/impl/SyncService.ts", "utf-8");
    expect(syncServiceCode).toContain("getHistoriesByIncidentIds");
    expect(syncServiceCode).not.toContain("await incidentHistoryRepo.getIncidentHistory(");
  });
});
