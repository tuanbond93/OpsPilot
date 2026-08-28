export interface FollowupConfig {
  firstReminderDelayHours: number;
  secondReminderDelayHours: number;
  thirdReminderDelayHours: number;
  escalationDelayHours: number;
  closureDelayHours: number;
  minimumImprovementPercent: number; // e.g. 20 (meaning >= 20% reduction)
}

export const DEFAULT_FOLLOWUP_CONFIG: FollowupConfig = {
  firstReminderDelayHours: 2,
  secondReminderDelayHours: 2,
  thirdReminderDelayHours: 2,
  escalationDelayHours: 2,
  closureDelayHours: 24,
  minimumImprovementPercent: 20,
};

export default DEFAULT_FOLLOWUP_CONFIG;
