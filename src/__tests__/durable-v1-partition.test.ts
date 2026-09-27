import { describe, expect, it } from "vitest";
import { durableV1InputHash, partitionV1CandidateKeys, V1_FOLLOWUP_CHUNK_SIZE } from "@/services/durable-v1-followup";

describe("Release B V1 work identity", () => {
  it("hashes saved JSON independently of database object key order", () => {
    const first = [{ orderCode: "A", nested: { b: 2, a: 1 } }] as never;
    const second = [{ nested: { a: 1, b: 2 }, orderCode: "A" }] as never;
    expect(durableV1InputHash("2026-09-27T11:00:00.000Z", first, []))
      .toBe(durableV1InputHash("2026-09-27T11:00:00.000Z", second, []));
  });
  it.each([
    [540, 22],
    [1080, 44],
    [2160, 87],
  ])("partitions %i candidates into %i bounded units without loss", (count, expected) => {
    const keys = Array.from({ length: count }, (_, index) => `CASE_${index}`);
    const chunks = partitionV1CandidateKeys(keys);
    expect(chunks).toHaveLength(expected);
    expect(chunks.every(chunk => chunk.length <= V1_FOLLOWUP_CHUNK_SIZE)).toBe(true);
    expect(chunks.flat()).toEqual(keys);
  });

  it("refuses ambiguous candidate identity before any queue write", () => {
    expect(() => partitionV1CandidateKeys(["A", "A"])).toThrow("V1_FOLLOWUP_CANDIDATE_IDENTITY_DUPLICATE");
  });
});
