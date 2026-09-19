/**
 * Governed Delivery Vehicle Operating Window
 *
 * Domain Rule:
 * Last-mile delivery vehicles only operate daily within:
 *   07:00 <= local clock time <= 17:00
 * Timezone: Asia/Ho_Chi_Minh
 *
 * Any vehicle-availability confirmation outside this window is operationally invalid.
 */

export const DELIVERY_OPERATING_WINDOW = {
  timezone: "Asia/Ho_Chi_Minh",
  daily_start: "07:00",
  daily_end: "17:00",
  start_hour: 7,
  start_minute: 0,
  end_hour: 17,
  end_minute: 0,
} as const;

export interface OperatingWindowClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dateStr: string; // YYYY-MM-DD
  timeStr: string; // HH:MM
  totalMinutes: number;
}

export function getOperatingWindowClockParts(
  time: number | string | Date,
  timeZone: string = DELIVERY_OPERATING_WINDOW.timezone
): OperatingWindowClockParts {
  const dateObj = new Date(time);
  if (isNaN(dateObj.getTime())) {
    throw new Error(`INVALID_TIMESTAMP: '${String(time)}' is not a valid date`);
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = formatter.formatToParts(dateObj);
  let year = 1970, month = 1, day = 1, hour = 0, minute = 0, second = 0;

  for (const p of parts) {
    if (p.type === "year") year = parseInt(p.value, 10);
    if (p.type === "month") month = parseInt(p.value, 10);
    if (p.type === "day") day = parseInt(p.value, 10);
    if (p.type === "hour") hour = parseInt(p.value, 10);
    if (p.type === "minute") minute = parseInt(p.value, 10);
    if (p.type === "second") second = parseInt(p.value, 10);
  }

  const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const totalMinutes = hour * 60 + minute;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dateStr,
    timeStr,
    totalMinutes,
  };
}

export function isWithinDeliveryOperatingWindow(
  time: number | string | Date,
  timeZone: string = DELIVERY_OPERATING_WINDOW.timezone
): boolean {
  const parts = getOperatingWindowClockParts(time, timeZone);
  const startMinutes = DELIVERY_OPERATING_WINDOW.start_hour * 60 + DELIVERY_OPERATING_WINDOW.start_minute; // 420
  const endMinutes = DELIVERY_OPERATING_WINDOW.end_hour * 60 + DELIVERY_OPERATING_WINDOW.end_minute; // 1020

  // 07:00 <= local time < 17:00 (at 17:00 the operational day concludes)
  return parts.totalMinutes >= startMinutes && parts.totalMinutes < endMinutes;
}

export type DeliveryOperatingWindowPosition =
  | "BEFORE_WINDOW"
  | "WITHIN_WINDOW"
  | "AFTER_WINDOW";

export function getDeliveryOperatingWindowPosition(
  time: number | string | Date,
  timeZone: string = DELIVERY_OPERATING_WINDOW.timezone
): {
  position: DeliveryOperatingWindowPosition;
  isWithinWindow: boolean;
  parts: OperatingWindowClockParts;
} {
  const parts = getOperatingWindowClockParts(time, timeZone);
  const startMinutes = DELIVERY_OPERATING_WINDOW.start_hour * 60 + DELIVERY_OPERATING_WINDOW.start_minute;
  const endMinutes = DELIVERY_OPERATING_WINDOW.end_hour * 60 + DELIVERY_OPERATING_WINDOW.end_minute;

  if (parts.totalMinutes < startMinutes) {
    return { position: "BEFORE_WINDOW", isWithinWindow: false, parts };
  }
  if (parts.totalMinutes >= endMinutes) {
    return { position: "AFTER_WINDOW", isWithinWindow: false, parts };
  }
  return { position: "WITHIN_WINDOW", isWithinWindow: true, parts };
}

export interface OperatingWindowValidationResult {
  valid: boolean;
  error?: string;
  earliestParts?: OperatingWindowClockParts;
  validUntilParts?: OperatingWindowClockParts;
}

/**
 * Validates delivery vehicle availability timestamps against the governed 07:00–17:00 window.
 *
 * Rules:
 * 1. earliest_available_at local clock time must be: >= 07:00 and < 17:00
 * 2. valid_until local clock time must be: > earliest_available_at and <= 17:00
 * 3. Both timestamps must belong to the exact same calendar operating day in Asia/Ho_Chi_Minh.
 * 4. Cross-midnight, overnight, or cross-day availability is explicitly rejected.
 */
export function validateDeliveryOperatingWindowTimestamps(
  earliestAvailableAt: string | null | undefined,
  validUntil: string | null | undefined,
  timeZone: string = DELIVERY_OPERATING_WINDOW.timezone
): OperatingWindowValidationResult {
  if (!validUntil) {
    return {
      valid: false,
      error: "MISSING_FIELD: valid_until is required",
    };
  }

  let untilParts: OperatingWindowClockParts;
  try {
    untilParts = getOperatingWindowClockParts(validUntil, timeZone);
  } catch (err: any) {
    return { valid: false, error: err.message };
  }

  const startMinutes = DELIVERY_OPERATING_WINDOW.start_hour * 60 + DELIVERY_OPERATING_WINDOW.start_minute; // 420 (07:00)
  const endMinutes = DELIVERY_OPERATING_WINDOW.end_hour * 60 + DELIVERY_OPERATING_WINDOW.end_minute; // 1020 (17:00)

  let earliestParts: OperatingWindowClockParts | undefined;
  if (earliestAvailableAt) {
    try {
      earliestParts = getOperatingWindowClockParts(earliestAvailableAt, timeZone);
    } catch (err: any) {
      return { valid: false, error: err.message };
    }

    // Rule: Same calendar operating day
    if (earliestParts.dateStr !== untilParts.dateStr) {
      return {
        valid: false,
        error: `OUTSIDE_OPERATING_WINDOW: earliest_available_at (${earliestParts.dateStr}) and valid_until (${untilParts.dateStr}) must be on the same governed delivery operating day. Cross-day or cross-midnight facts are rejected.`,
        earliestParts,
        validUntilParts: untilParts,
      };
    }
  }

  // Validate valid_until boundary: must be <= 17:00 (and second <= 0 if exact 17:00)
  const untilTotalSeconds = untilParts.totalMinutes * 60 + untilParts.second;
  const maxEndSeconds = endMinutes * 60; // 17:00:00

  if (untilTotalSeconds > maxEndSeconds) {
    return {
      valid: false,
      error: `OUTSIDE_OPERATING_WINDOW: valid_until (${untilParts.timeStr}) exceeds the daily delivery operating window (07:00–17:00 ${timeZone}). Delivery vehicles do not operate after 17:00.`,
      earliestParts,
      validUntilParts: untilParts,
    };
  }

  if (untilTotalSeconds <= startMinutes * 60) {
    return {
      valid: false,
      error: `OUTSIDE_OPERATING_WINDOW: valid_until (${untilParts.timeStr}) must be strictly after daily opening (07:00 ${timeZone}).`,
      earliestParts,
      validUntilParts: untilParts,
    };
  }

  if (earliestParts) {
    const earliestTotalSeconds = earliestParts.totalMinutes * 60 + earliestParts.second;

    // Rule 1: earliest_available_at >= 07:00
    if (earliestTotalSeconds < startMinutes * 60) {
      return {
        valid: false,
        error: `OUTSIDE_OPERATING_WINDOW: earliest_available_at (${earliestParts.timeStr}) is before daily operating window start (07:00 ${timeZone}).`,
        earliestParts,
        validUntilParts: untilParts,
      };
    }

    // Rule 1: earliest_available_at < 17:00
    if (earliestTotalSeconds >= maxEndSeconds) {
      return {
        valid: false,
        error: `OUTSIDE_OPERATING_WINDOW: earliest_available_at (${earliestParts.timeStr}) cannot be at or after daily operating window close (17:00 ${timeZone}).`,
        earliestParts,
        validUntilParts: untilParts,
      };
    }

    // Rule 2: valid_until > earliest_available_at
    if (untilTotalSeconds <= earliestTotalSeconds) {
      return {
        valid: false,
        error: `OUTSIDE_OPERATING_WINDOW: valid_until (${untilParts.timeStr}) must be strictly greater than earliest_available_at (${earliestParts.timeStr}).`,
        earliestParts,
        validUntilParts: untilParts,
      };
    }

    return {
      valid: true,
      earliestParts,
      validUntilParts: untilParts,
    };
  }

  return {
    valid: true,
    validUntilParts: untilParts,
  };
}
