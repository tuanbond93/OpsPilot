import { MB03_DISCOVERY_TYPE, type Mb03DiscoveryState } from "@/services/telegram-mb03-discovery";

export type Mb03ConversationEvent = {
  ai_result: unknown;
  created_at: string;
  member_id?: string | null;
  telegram_user_id?: number | null;
  source_chat_type?: string | null;
};

export type Mb03ReadinessCase = Pick<Mb03DiscoveryState, "caseId" | "status" | "warehouseName" | "outcomeDueAt" | "updatedAt">;

function isMb03State(value: unknown): value is Mb03DiscoveryState {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === MB03_DISCOVERY_TYPE
    && typeof (value as { caseId?: unknown }).caseId === "string"
    && typeof (value as { status?: unknown }).status === "string");
}

/** Reduces immutable Telegram conversation events to the latest state per case. */
export function latestMb03States(events: Mb03ConversationEvent[]) {
  const latest = new Map<string, Mb03DiscoveryState>();
  for (const event of events) {
    if (!isMb03State(event.ai_result)) continue;
    const candidate = event.ai_result;
    const existing = latest.get(candidate.caseId);
    const candidateTime = Date.parse(candidate.updatedAt || event.created_at);
    const existingTime = existing ? Date.parse(existing.updatedAt) : Number.NEGATIVE_INFINITY;
    if (!existing || candidateTime >= existingTime) latest.set(candidate.caseId, candidate);
  }

  return latest;
}

export function buildMb03ReadinessSnapshot(events: Mb03ConversationEvent[], now = new Date()) {
  const latest = latestMb03States(events);
  const cases: Mb03ReadinessCase[] = [...latest.values()]
    .map((state) => ({ caseId: state.caseId, status: state.status, warehouseName: state.warehouseName, outcomeDueAt: state.outcomeDueAt, updatedAt: state.updatedAt }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const overdue = cases.filter((item) => item.status === "AWAITING_OUTCOME" && Number.isFinite(Date.parse(String(item.outcomeDueAt || ""))) && Date.parse(String(item.outcomeDueAt)) <= now.getTime());

  return {
    totalCases: cases.length,
    active: cases.filter((item) => item.status === "ACTIVE").length,
    awaitingOutcome: cases.filter((item) => item.status === "AWAITING_OUTCOME").length,
    overdueOutcome: overdue.length,
    completed: cases.filter((item) => item.status === "COMPLETED").length,
    cancelled: cases.filter((item) => item.status === "CANCELLED").length,
    overdueCases: overdue,
  };
}
