import { describe, expect, it } from "vitest";
import {
  durableV1InputHash,
  partitionV1CandidateKeys,
  partitionWeightedV1Candidates,
  V1_FOLLOWUP_CHUNK_SIZE,
} from "@/services/durable-v1-followup";

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

  it("creates deterministic Policy B boundaries without splitting or losing cases", () => {
    const memberCounts = [72, 62, 170, 68, 58, 267, 47, 1481, 870, 49, 39, 55, 29, 40, 35, 26, 30, 167, 101, 71, 474, 108, 60, 24, 36];
    const keys = memberCounts.map((_, index) => `CASE_${index + 1}`);
    const codes = new Map<string, Set<string>>();
    const orders = new Map<string, any>();
    keys.forEach((key, caseIndex) => {
      const members = new Set<string>();
      for (let memberIndex = 0; memberIndex < memberCounts[caseIndex]; memberIndex++) {
        const code = `${key}_ORDER_${memberIndex}`;
        members.add(code);
        orders.set(code, { orderCode: code });
      }
      codes.set(key, members);
    });

    const first = partitionWeightedV1Candidates(keys, codes, orders);
    const retry = partitionWeightedV1Candidates(keys, codes, orders);
    expect(first).toEqual(retry);
    expect(first.map(unit => unit.length)).toEqual([8, 17]);
    expect(first.map(unit => unit.reduce((sum, key) => sum + (codes.get(key)?.size || 0), 0))).toEqual([2225, 2214]);
    expect(first.flat()).toEqual(keys);
    expect(new Set(first.flat()).size).toBe(keys.length);
  });

  it("keeps an overweight single case atomic and alone", () => {
    const keys = ["HEAVY", "LIGHT"];
    const codes = new Map<string, Set<string>>([
      ["HEAVY", new Set(Array.from({ length: 2501 }, (_, index) => `H${index}`))],
      ["LIGHT", new Set(["L1"])],
    ]);
    const orders = new Map([...codes.values()].flatMap(set => [...set]).map(code => [code, { orderCode: code }]));
    expect(partitionWeightedV1Candidates(keys, codes, orders as any)).toEqual([["HEAVY"], ["LIGHT"]]);
  });

  it("bounds real serialized input bytes while preserving original order", () => {
    const keys = ["A", "B", "C"];
    const codes = new Map(keys.map(key => [key, new Set([key])]));
    const orders = new Map(keys.map(key => [key, { orderCode: key, payload: "x".repeat(700_000) }]));
    expect(partitionWeightedV1Candidates(keys, codes, orders as any)).toEqual([["A", "B"], ["C"]]);
  });
});
