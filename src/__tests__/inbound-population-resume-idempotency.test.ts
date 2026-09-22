import { describe, expect, it } from "vitest";
import type {
  IInboundOrderObservationRepository,
  InboundOrderObservationRow,
  InboundPopulationManifestInput,
} from "@/repositories/interfaces/IInboundOrderObservationRepository";

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE = "RILLNET" as const;

const manifestInput = (expected: number): InboundPopulationManifestInput => ({
  sync_run_id: RUN_ID,
  source_system: SOURCE,
  normalized_population_count: expected,
  expected_observation_count: expected,
  duplicate_identical_count: 0,
  duplicate_conflict_count: 0,
  source_freshness: "2026-09-22T01:00:00.000Z",
});

const rows = (count: number, prefix: string): InboundOrderObservationRow[] =>
  Array.from({ length: count }, (_, index) => ({
    sync_run_id: RUN_ID,
    source_system: SOURCE,
    order_code: `${prefix}-${index + 1}`,
    current_warehouse_id: "WH-1",
    deliver_warehouse_id: "WH-2",
    source_status: "transporting",
    source_observed_at: "2026-09-22T01:00:00.000Z",
  }));

class InMemoryPopulationRepository implements IInboundOrderObservationRepository {
  private manifestStatus: "STARTED" | "FAILED" | "COMPLETE" | null = null;
  private persisted = new Map<string, InboundOrderObservationRow>();
  private failAfterInsert: number | null = null;

  seed(status: "STARTED" | "FAILED" | "COMPLETE", seededRows: InboundOrderObservationRow[]): void {
    this.manifestStatus = status;
    this.persisted = new Map(seededRows.map((row) => [row.order_code, row]));
  }

  interruptAfter(insertCount: number): void {
    this.failAfterInsert = insertCount;
  }

  getStatus(): string | null {
    return this.manifestStatus;
  }

  getRows(): InboundOrderObservationRow[] {
    return [...this.persisted.values()];
  }

  async replaceIncompletePopulation(_input: InboundPopulationManifestInput): Promise<void> {
    if (this.manifestStatus === "COMPLETE") {
      throw new Error("INBOUND_POPULATION_REPLACEMENT_FORBIDDEN_COMPLETED");
    }
    this.manifestStatus = "STARTED";
    this.persisted.clear();
  }

  async insertBatch(input: InboundOrderObservationRow[]): Promise<number> {
    let inserted = 0;
    for (const row of input) {
      if (!this.persisted.has(row.order_code)) {
        this.persisted.set(row.order_code, row);
        inserted += 1;
      }
      if (this.failAfterInsert !== null && inserted >= this.failAfterInsert) {
        this.failAfterInsert = null;
        throw new Error("SIMULATED_INTERRUPTION_AFTER_REPLACEMENT");
      }
    }
    return inserted;
  }

  async countPersisted(_syncRunId: string, _sourceSystem: "RILLNET"): Promise<number> {
    return this.persisted.size;
  }

  async completePopulation(_input: InboundPopulationManifestInput & { persisted_observation_count: number; population_completed_at: string }): Promise<void> {
    this.manifestStatus = "COMPLETE";
  }

  async failPopulation(_input: Pick<InboundPopulationManifestInput, "sync_run_id" | "source_system"> & { failure_reason: string }): Promise<void> {
    if (this.manifestStatus !== "COMPLETE") this.manifestStatus = "FAILED";
  }
}

async function rebuild(
  repository: InMemoryPopulationRepository,
  expected: number,
  sourceRows: InboundOrderObservationRow[],
): Promise<void> {
  const input = manifestInput(expected);
  try {
    await repository.replaceIncompletePopulation(input);
    await repository.insertBatch(sourceRows);
    const persistedCount = await repository.countPersisted(RUN_ID, SOURCE);
    if (persistedCount !== input.expected_observation_count) {
      throw new Error(`INBOUND_POPULATION_COUNT_MISMATCH: expected ${input.expected_observation_count}, found ${persistedCount}`);
    }
    await repository.completePopulation({
      ...input,
      persisted_observation_count: persistedCount,
      population_completed_at: "2026-09-22T01:00:30.000Z",
    });
  } catch (error) {
    await repository.failPopulation({
      sync_run_id: RUN_ID,
      source_system: SOURCE,
      failure_reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

describe("inbound population replacement and resume contract", () => {
  it("replaces 9704 stale rows with the 9683-row source population", async () => {
    const repository = new InMemoryPopulationRepository();
    repository.seed("FAILED", rows(9704, "old"));

    await rebuild(repository, 9683, rows(9683, "new"));

    expect(repository.getRows()).toHaveLength(9683);
    expect(new Set(repository.getRows().map((row) => row.order_code)).size).toBe(9683);
    expect(repository.getRows().every((row) => row.order_code.startsWith("new-"))).toBe(true);
    expect(repository.getStatus()).toBe("COMPLETE");
  });

  it("supports the inverse population change from 9683 to 9704", async () => {
    const repository = new InMemoryPopulationRepository();
    repository.seed("FAILED", rows(9683, "old"));

    await rebuild(repository, 9704, rows(9704, "new"));

    expect(repository.getRows()).toHaveLength(9704);
    expect(new Set(repository.getRows().map((row) => row.order_code)).size).toBe(9704);
    expect(repository.getStatus()).toBe("COMPLETE");
  });

  it("rebuilds an interrupted replacement on the next retry", async () => {
    const repository = new InMemoryPopulationRepository();
    repository.seed("FAILED", rows(9704, "old"));
    repository.interruptAfter(100);

    await expect(rebuild(repository, 9683, rows(9683, "new"))).rejects.toThrow("SIMULATED_INTERRUPTION");
    expect(repository.getStatus()).toBe("FAILED");

    await rebuild(repository, 9683, rows(9683, "new"));
    expect(repository.getRows()).toHaveLength(9683);
    expect(repository.getRows().every((row) => row.order_code.startsWith("new-"))).toBe(true);
    expect(repository.getStatus()).toBe("COMPLETE");
  });

  it("retries an identical source population without accumulating rows", async () => {
    const repository = new InMemoryPopulationRepository();
    repository.seed("FAILED", rows(9683, "old"));
    const sourceRows = rows(9683, "same");
    repository.interruptAfter(100);

    await expect(rebuild(repository, 9683, sourceRows)).rejects.toThrow("SIMULATED_INTERRUPTION");
    await rebuild(repository, 9683, sourceRows);

    expect(repository.getRows()).toHaveLength(9683);
    expect(new Set(repository.getRows().map((row) => row.order_code)).size).toBe(9683);
    expect(repository.getStatus()).toBe("COMPLETE");
  });

  it("does not replace a completed population", async () => {
    const repository = new InMemoryPopulationRepository();
    repository.seed("COMPLETE", rows(9683, "complete"));

    await expect(rebuild(repository, 9704, rows(9704, "new"))).rejects.toThrow(
      "INBOUND_POPULATION_REPLACEMENT_FORBIDDEN_COMPLETED",
    );
    expect(repository.getStatus()).toBe("COMPLETE");
    expect(repository.getRows()).toHaveLength(9683);
    expect(repository.getRows().every((row) => row.order_code.startsWith("complete-"))).toBe(true);
  });

  it("keeps exact equality as a hard invariant", async () => {
    const repository = new InMemoryPopulationRepository();
    repository.seed("FAILED", rows(10, "old"));

    await expect(rebuild(repository, 3, rows(2, "new"))).rejects.toThrow(
      "INBOUND_POPULATION_COUNT_MISMATCH: expected 3, found 2",
    );
    expect(repository.getStatus()).toBe("FAILED");
  });
});
