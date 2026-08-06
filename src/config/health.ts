export const HEALTH_CONFIG = {
  ttls: {
    database: 60, // 1 minute
    aiWorker: 3600, // 1 hour
    notificationPlatform: 3600, // 1 hour
    cronWorker: 7200, // 2 hours
  },
  failureThresholds: {
    database: 1,
    aiWorker: 5,
    notificationPlatform: 5,
  },
};
