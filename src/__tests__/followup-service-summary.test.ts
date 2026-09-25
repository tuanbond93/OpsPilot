import { describe, expect, it, vi } from "vitest";
import { FollowupService } from "@/services/impl/FollowupService";

describe("follow-up dashboard summary reads", () => {
  it("uses the repository summary path without invoking full cohort hydration", async () => {
    const rows = [{ id: "case-1", current_state: "FOLLOWING_UP" }];
    const repository = {
      getAllCasesSummary: vi.fn().mockResolvedValue(rows),
      getAllCases: vi.fn().mockRejectedValue(new Error("full hydration must not run for the dashboard")),
    };
    const service = new FollowupService(repository as any);

    await expect(service.getAllCasesSummary()).resolves.toEqual({ totalCases: 1, cases: rows });
    expect(repository.getAllCasesSummary).toHaveBeenCalledOnce();
    expect(repository.getAllCases).not.toHaveBeenCalled();
  });
});
