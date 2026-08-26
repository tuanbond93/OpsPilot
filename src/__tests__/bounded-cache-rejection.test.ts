import { describe, it, expect, beforeEach } from 'vitest';
import { BoundedCache, ROOT_CAUSE_CACHE_MAX_ENTRIES } from '../../src/agents/root-cause/bounded-cache';

describe('BoundedCache', () => {
  let cache: BoundedCache<string, number>;

  beforeEach(() => {
    cache = new BoundedCache<string, number>(ROOT_CAUSE_CACHE_MAX_ENTRIES);
  });

  it('should miss on empty cache', () => {
    expect(cache.get('key')).toBeUndefined();
  });

  it('should store and retrieve a value', () => {
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it('should update recentness on get', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    // access 'a' to make it most recent
    expect(cache.get('a')).toBe(1);
    // add entries to fill the cache; 'b' should be evicted first (LRU)
    // We add (MAX - 1) entries so 'a' + (MAX-1) new = MAX total, 'b' gets evicted
    for (let i = 0; i < ROOT_CAUSE_CACHE_MAX_ENTRIES - 1; i++) {
      cache.set(`k${i}`, i);
    }
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
  });

  it('should not exceed max entries', () => {
    for (let i = 0; i < ROOT_CAUSE_CACHE_MAX_ENTRIES + 10; i++) {
      cache.set(`key${i}`, i);
    }
    const diagnostics = cache.diagnostics();
    expect(diagnostics.size).toBeLessThanOrEqual(ROOT_CAUSE_CACHE_MAX_ENTRIES);
    expect(diagnostics.evictionCount).toBeGreaterThan(0);
  });

  it('should report diagnostics without leaking private data', () => {
    cache.set('secret-key-1', 42);
    cache.get('secret-key-1');
    cache.get('nonexistent');
    const diag = cache.diagnostics();
    expect(diag).toEqual({
      size: 1,
      hitCount: 1,
      missCount: 1,
      evictionCount: 0,
    });
    // Ensure no key or value data leaks into diagnostics
    const diagStr = JSON.stringify(diag);
    expect(diagStr).not.toContain('secret');
    expect(diagStr).not.toContain('42');
  });
});

// Rejection schema and type tests
import type { RecommendationRejectionDetail } from '../../src/agents/action-planner/schema';
import type { PlannerResult } from '../../src/agents/action-planner/schema';

describe('RecommendationRejectionDetail schema', () => {
  it('should accept a valid rejection detail', () => {
    const rejection: RecommendationRejectionDetail = {
      recommendationIndex: 0,
      code: 'INVALID_ACTION_TYPE',
      reason: 'Type not allowed',
    };
    expect(rejection.code).toBe('INVALID_ACTION_TYPE');
    expect(rejection.recommendationIndex).toBe(0);
    expect(rejection.reason).toBe('Type not allowed');
  });

  it('PlannerResult.rejections should be optional', () => {
    // A PlannerResult without rejections should be valid
    const result: PlannerResult = {
      executiveSummary: 'test',
      overallPriority: 'medium',
      recommendations: [],
      investigations: [],
      blockedOptions: [],
      nextReview: { source: 'PLANNER_POLICY', reviewAt: '', reviewAfterMinutes: 30, rationale: '' },
      confidence: { score: 0.5, level: 'medium', factors: [] },
      limitations: [],
      metadata: { provider: 'test', model: 'test', promptVersion: 'v1', generatedAt: new Date().toISOString() },
    };

    expect(result.rejections).toBeUndefined();
  });

  it('PlannerResult.rejections should accept rejection details when present', () => {
    const result: PlannerResult = {
      executiveSummary: 'test',
      overallPriority: 'medium',
      recommendations: [],
      investigations: [],
      blockedOptions: [],
      nextReview: { source: 'PLANNER_POLICY', reviewAt: '', reviewAfterMinutes: 30, rationale: '' },
      confidence: { score: 0.5, level: 'medium', factors: [] },
      limitations: [],
      rejections: [
        { recommendationIndex: 0, code: 'INVALID_ACTION_TYPE', reason: 'Not allowed' },
        { recommendationIndex: 1, code: 'INVALID_TARGET_ROLE', reason: 'Role not permitted' },
      ],
      metadata: { provider: 'test', model: 'test', promptVersion: 'v1', generatedAt: new Date().toISOString() },
    };

    expect(result.rejections).toHaveLength(2);
    expect(result.rejections![0].code).toBe('INVALID_ACTION_TYPE');
    expect(result.rejections![1].code).toBe('INVALID_TARGET_ROLE');
  });

  it('limitations should remain string[] for backward compatibility', () => {
    const result: PlannerResult = {
      executiveSummary: 'test',
      overallPriority: 'medium',
      recommendations: [],
      investigations: [],
      blockedOptions: [],
      nextReview: { source: 'PLANNER_POLICY', reviewAt: '', reviewAfterMinutes: 30, rationale: '' },
      confidence: { score: 0.5, level: 'medium', factors: [] },
      limitations: ['Missing data: inventory levels', 'Missing data: shift schedule'],
      metadata: { provider: 'test', model: 'test', promptVersion: 'v1', generatedAt: new Date().toISOString() },
    };

    expect(result.limitations).toBeInstanceOf(Array);
    result.limitations.forEach(l => expect(typeof l).toBe('string'));
  });
});
