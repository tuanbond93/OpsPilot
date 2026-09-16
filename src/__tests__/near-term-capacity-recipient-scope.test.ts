import { describe, expect, it, vi } from "vitest";
import { NearTermCapacityRuntimeService, selectScopedIncidentBatch, selectScopedLeadRecipient } from "@/services/near-term-capacity-runtime";
import type { ResolvedRecipient } from "@/notifications/gateway/scope-resolver";

const lead: ResolvedRecipient = {
  memberId: "lead-1", telegramUserId: 7, displayName: "Pilot Lead", username: "lead",
  role: "MANAGER", privateChatId: null, onboardingState: "UNKNOWN", groupId: "group-1", scopeMatchReason: "scope_region:MB03",
};
const groups = [{ id: "group-1", telegram_chat_id: -1001, status: "ACTIVE" }];
const topics = [
  { group_id: "group-1", message_thread_id: 12, province_name: "Yên Bái", is_manager_decision: false, status: "ACTIVE" },
  { group_id: "group-1", message_thread_id: 13, province_name: "Lào Cai", is_manager_decision: false, status: "ACTIVE" },
  { group_id: "group-1", message_thread_id: 111, province_name: null, is_manager_decision: true, status: "ACTIVE" },
];

describe("near-term capacity Lead recipient scope", () => {
  it("applies governed scope before the bounded detector limit", () => {
    const global = Array.from({ length: 20 }, (_, index) => ({ id: `out-${index}`, inScope: false }))
      .concat(Array.from({ length: 5 }, (_, index) => ({ id: `in-${index}`, inScope: true })));
    expect(selectScopedIncidentBatch(global, (incident) => incident.inScope)).toHaveLength(5);
    expect(selectScopedIncidentBatch(global, (incident) => incident.inScope).map((incident) => incident.id)).toEqual(["in-0", "in-1", "in-2", "in-3", "in-4"]);
  });

  it("keeps the deterministic source order when more than 20 incidents are in scope", () => {
    const incidents = Array.from({ length: 50 }, (_, index) => ({ id: index, inScope: true }));
    expect(selectScopedIncidentBatch(incidents, (incident) => incident.inScope)).toHaveLength(20);
    expect(selectScopedIncidentBatch(incidents, (incident) => incident.inScope).at(-1)?.id).toBe(19);
  });

  it("does not fabricate a candidate when no incident is in scope", () => {
    expect(selectScopedIncidentBatch([{ inScope: false }], (incident) => incident.inScope)).toEqual([]);
  });

  it("routes a governed warehouse A to the single active Lead", () => {
    expect(selectScopedLeadRecipient({ scopedManagers: [lead], groups, topics, province: "Yên Bái" })).toMatchObject({ member: lead, chatId: "-1001", messageThreadId: 12 });
  });

  it("routes a different governed warehouse B to the same Lead", () => {
    expect(selectScopedLeadRecipient({ scopedManagers: [lead], groups, topics, province: "Lào Cai" })).toMatchObject({ member: lead, chatId: "-1001", messageThreadId: 13 });
  });

  it("keeps one Lead eligible across every governed warehouse topic", () => {
    for (const province of ["Yên Bái", "Lào Cai"]) {
      expect(selectScopedLeadRecipient({ scopedManagers: [lead], groups, topics, province })).not.toBeNull();
    }
  });

  it("rejects a warehouse outside the Lead's governed scope", () => {
    expect(selectScopedLeadRecipient({ scopedManagers: [], groups, topics, province: "Yên Bái" })).toBeNull();
  });

  it("does not send when there is no active Lead", () => {
    expect(selectScopedLeadRecipient({ scopedManagers: [], groups: [], topics: [], province: "Yên Bái" })).toBeNull();
  });

  it("fails safely if more than one active Lead matches", () => {
    expect(selectScopedLeadRecipient({ scopedManagers: [lead, { ...lead, memberId: "lead-2" }], groups, topics, province: "Yên Bái" })).toBeNull();
  });

  it("does not create another fact request when an active capacity case already exists", async () => {
    const from = vi.fn((table: string) => {
      if (table !== "near_term_capacity_cases") throw new Error(`Unexpected table ${table}`);
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "existing", active: true }, error: null }) }) }) };
    });
    const service = new NearTermCapacityRuntimeService({ from } as any);
    await expect(service.runCheckpoint()).resolves.toMatchObject({ status: "ACTIVE_CASE_EXISTS", fact_requests_sent: 0 });
    expect(from).toHaveBeenCalledTimes(1);
  });
});
