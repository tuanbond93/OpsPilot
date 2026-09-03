/**
 * Privacy-minimised projection of the GHN hub schedule response.
 * User identifiers are used only while calculating intersections and never
 * leave this module. Names, contact details and individual shifts are not
 * represented in the output.
 */
export type LastmileScheduleShift = {
  startAt: string;
  endAt: string;
  isOnLeave: boolean;
};

export type LastmileScheduledUser = {
  userId: string;
  schedules: Array<{
    dateLabel: string;
    shifts: LastmileScheduleShift[];
  }>;
};

export type LastmileScheduleWeekday = {
  date: string;
  value: string;
};

export type ScheduledStaffingSnapshot = {
  hubId: string;
  scheduleDate: string;
  scheduledForDayCount: number;
  currentlyScheduledWorkforceCount: number;
  onLeaveCount: number;
  activeDriverCount: number;
  scheduledActiveDriverCount: number;
  unscheduledActiveDriverCount: number;
  sourceFetchedAt: string;
};

const localDateAndTime = (at: string) => {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid snapshot time");
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => values.find((value) => value.type === type)?.value || "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
};

const isWithinShift = (time: string, shift: LastmileScheduleShift) => {
  if (!/^\d{2}:\d{2}$/.test(shift.startAt) || !/^\d{2}:\d{2}$/.test(shift.endAt)) return false;
  if (shift.startAt <= shift.endAt) return time >= shift.startAt && time < shift.endAt;
  return time >= shift.startAt || time < shift.endAt;
};

/**
 * Counts scheduled workforce only. It must not be presented as actual
 * attendance or available capacity: the schedule source has neither signal.
 */
export function buildScheduledStaffingSnapshot(args: {
  hubId: string;
  users: LastmileScheduledUser[];
  weekdays: LastmileScheduleWeekday[];
  activeDriverIds: string[];
  at: string;
  sourceFetchedAt: string;
}): ScheduledStaffingSnapshot {
  const current = localDateAndTime(args.at);
  const currentLabel = args.weekdays.find((weekday) => localDateAndTime(weekday.date).date === current.date)?.value;
  if (!currentLabel) throw new Error("Schedule response does not cover the requested local date");

  const scheduledUserIds = new Set<string>();
  const currentlyScheduledUserIds = new Set<string>();
  const onLeaveUserIds = new Set<string>();
  for (const user of args.users) {
    if (!user.userId) continue;
    const shifts = user.schedules.find((schedule) => schedule.dateLabel === currentLabel)?.shifts || [];
    const workingShifts = shifts.filter((shift) => !shift.isOnLeave);
    if (workingShifts.length) scheduledUserIds.add(user.userId);
    if (workingShifts.some((shift) => isWithinShift(current.time, shift))) currentlyScheduledUserIds.add(user.userId);
    if (shifts.length && workingShifts.length === 0) onLeaveUserIds.add(user.userId);
  }

  const activeDrivers = new Set(args.activeDriverIds.filter(Boolean));
  const scheduledActiveDriverCount = [...activeDrivers].filter((driverId) => currentlyScheduledUserIds.has(driverId)).length;
  return {
    hubId: args.hubId,
    scheduleDate: current.date,
    scheduledForDayCount: scheduledUserIds.size,
    currentlyScheduledWorkforceCount: currentlyScheduledUserIds.size,
    onLeaveCount: onLeaveUserIds.size,
    activeDriverCount: activeDrivers.size,
    scheduledActiveDriverCount,
    unscheduledActiveDriverCount: activeDrivers.size - scheduledActiveDriverCount,
    sourceFetchedAt: args.sourceFetchedAt,
  };
}
