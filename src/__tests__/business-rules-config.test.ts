import { describe, it, expect } from 'vitest';
import { BusinessRules } from '../config/business-rules';

describe('BusinessRules configuration', () => {
  it('should have correct priority thresholds', () => {
    expect(BusinessRules.priority.high).toBe(50);
    expect(BusinessRules.priority.critical).toBe(75);
  });

  it('should have correct AI values', () => {
    expect(BusinessRules.ai.rootCauseWeight).toBe(30);
    expect(BusinessRules.ai.maxConfidenceFactor).toBe(30);
  });

  it('should have correct tier2 risk configuration', () => {
    expect(BusinessRules.ai.riskTiers.tier2.min).toBe(21);
    expect(BusinessRules.ai.riskTiers.tier2.max).toBe(50);
  });
});
