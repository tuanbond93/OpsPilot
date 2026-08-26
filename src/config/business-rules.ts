/**
 * Business rule configuration for OpsPilot.
 * This module externalizes verified policy values that may be modified by operations.
 */
export interface BusinessRuleConfiguration {
  /** Priority thresholds */
  readonly priority: {
    /** High priority threshold (inclusive) */
    readonly high: number;
    /** Critical priority threshold (inclusive) */
    readonly critical: number;
  };

  /** AI related rule values */
  readonly ai: {
    /** Weight for root-cause confidence contribution (max +30) */
    readonly rootCauseWeight: number;
    /** Maximum confidence factor contribution (max +30) */
    readonly maxConfidenceFactor: number;

    /** Risk tier configuration */
    readonly riskTiers: {
      /** Tier 2 configuration */
      readonly tier2: {
        /** Minimum value for tier?2 */
        readonly min: number;
        /** Maximum value for tier?2 */
        readonly max: number;
      };
    };
  };
}

/** Immutable business rules object */
export const BusinessRules = {
  priority: {
    high: 50,
    critical: 75,
  },
  ai: {
    rootCauseWeight: 30,
    maxConfidenceFactor: 30,
    riskTiers: {
      tier2: {
        min: 21,
        max: 50,
      },
    },
  },
} as const satisfies BusinessRuleConfiguration;
