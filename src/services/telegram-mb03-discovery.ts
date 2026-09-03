import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TelegramClient } from "@/integrations/telegram/telegram-client";
import warehouseAssignments from "@/data/warehouse-assignments.generated.json";

export const MB03_DISCOVERY_TYPE = "MB03_DISCOVERY";
export const MB03_SCOPE_CODE = "MB03";

export type DiscoveryStep =
  | "PLAYBOOK_FIT"
  | "PLAYBOOK_ACTION"
  | "GAP_EXPLANATION"
  | "PROBLEM"
  | "RESOURCE"
  | "OPTION_A"
  | "OPTION_B"
  | "TRADE_OFF"
  | "RULE_CHECK"
  | "CONTEXT_GAPS"
  | "AUTHORITY"
  | "ACTION"
  | "BASELINE"
  | "OUTCOME_RULE"
  | "WINDOW_HOURS"
  | "MANAGER_THINKING";

export type DiscoveryStatus = "ACTIVE" | "AWAITING_OUTCOME" | "COMPLETED" | "CANCELLED";
export type DiscoveryOutcome = "SUCCESS" | "FAILURE" | "INCONCLUSIVE";
export type Mb03DiscoveryLane = "ROUTINE_TRIAGE" | "TRUE_DECISION";

export type Mb03DiscoveryState = {
  type: typeof MB03_DISCOVERY_TYPE;
  version: "MB03_DISCOVERY_V1" | "MB03_DISCOVERY_V2";
  sessionId: string;
  caseId: string;
  scopeCode: typeof MB03_SCOPE_CODE;
  warehouseName: string;
  status: DiscoveryStatus;
  step: DiscoveryStep | null;
  answers: Partial<Record<DiscoveryStep, string>>;
  chatId: string;
  messageThreadId: number | null;
  startedAt: string;
  updatedAt: string;
  outcomeDueAt?: string;
  reminderSentAt?: string;
  outcome?: { classification: DiscoveryOutcome; evidence: string; recordedAt: string };
  incidentId?: string;
  incidentKey?: string;
  incidentSnapshotKey?: string;
  reasonName?: string;
  reasonCode?: string;
  orderCodes?: string[];
  provinceName?: string;
  decisionClass?: Mb03DecisionClass;
  /** V2 uses routine triage by default; only a playbook gap enters the C2
   * candidate lane. V1 records deliberately retain their historical shape. */
  lane?: Mb03DiscoveryLane;
  /** Later clarification of a gate field.  The original reply remains in its
   * own immutable conversation event; this records who supplied the
   * correction, when, and why rather than silently overwriting evidence. */
  amendments?: Partial<Record<"RULE_CHECK" | "CONTEXT_GAPS", { value: string; reason: string; recordedAt: string }>>;
};

export const MB03_DECISION_CLASSES = [
  "MULTI_STATUS_WAREHOUSE_PRIORITIZATION",
  "WAREHOUSE_CAPACITY_REALLOCATION",
  "SLA_VS_BACKLOG_PRIORITIZATION",
  "RE_ROUTE_HOLD_ESCALATE",
  "OTHER_REAL_CLASS",
  "NOT_A_TRUE_DECISION",
] as const;
export type Mb03DecisionClass = (typeof MB03_DECISION_CLASSES)[number];

const trueDecisionSteps: DiscoveryStep[] = [
  "PROBLEM", "RESOURCE", "OPTION_A", "OPTION_B", "TRADE_OFF", "RULE_CHECK",
  "CONTEXT_GAPS", "AUTHORITY", "ACTION", "BASELINE", "OUTCOME_RULE",
  "WINDOW_HOURS", "MANAGER_THINKING",
];

const prompts: Record<DiscoveryStep, string> = {
  PLAYBOOK_FIT: "Playbook có bao phủ finding này không? Chọn COVERED nếu action kiểm tra đã rõ theo chặng; chọn OUTSIDE chỉ khi timeline hợp lệ nhưng không khớp rule/playbook.",
  PLAYBOOK_ACTION: "Ghi action kiểm tra theo đúng finding và chặng chịu trách nhiệm. Không điều phối hay đổi trạng thái đơn.",
  GAP_EXPLANATION: "Giải thích vì sao timeline/finding không khớp playbook hiện có. Nêu checkpoint, thời điểm và evidence; không suy đoán.",
  PROBLEM: "True Decision 1/13 — Mô tả vấn đề bằng số liệu + thời điểm + nguồn evidence. Không gửi PII.",
  RESOURCE: "True Decision 2/13 — Ràng buộc hoặc quy tắc nào khiến Manager phải tự cân nhắc? Có thể là SLA, chặng kho, tuyến, khách hàng, deadline hoặc capacity; chỉ ghi mục thực sự liên quan.",
  OPTION_A: "3/13 — Option A là gì? Viết thành một hành động có thể giao việc.",
  OPTION_B: "4/13 — Option B là gì? Phải khác A và cũng khả thi tại thời điểm quyết định.",
  TRADE_OFF: "5/13 — Trade-off: chọn A được/mất gì so với B? Ghi tác động hai chiều.",
  RULE_CHECK: "6/13 — Rule/template hiện tại có thể chọn an toàn không? Reply YES hoặc NO, rồi nêu lý do ngắn.",
  CONTEXT_GAPS: "7/13 — Còn thiếu context nào để so sánh A/B? Reply NONE nếu không thiếu; nếu thiếu hãy liệt kê.",
  AUTHORITY: "8/13 — Bạn có quyền chọn và giao action này không? Reply YES hoặc NO.",
  ACTION: "9/13 — Action thực tế đã giao hoặc sẽ giao là gì? Nêu owner theo vai trò, không ghi thông tin cá nhân.",
  BASELINE: "10/13 — Baseline metric trước action là gì và giá trị bao nhiêu? Kèm thời điểm snapshot.",
  OUTCOME_RULE: "11/13 — Viết SUCCESS rule, FAILURE rule và guardrail định lượng.",
  WINDOW_HOURS: "12/13 — Cửa sổ đo bao nhiêu giờ? Chỉ reply một số từ 1 đến 168.",
  MANAGER_THINKING: "13/13 — Mức suy nghĩ/điều tra ngoài OpsPilot: ZERO, LOW hoặc MEDIUM/HIGH?",
};

function clean(value: string, max = 2000) {
  return value.trim().replace(/\s+/g, " ").slice(0, max);
}

export function parseMb03StartCommand(text: string): { warehouseName: string | null } | null {
  const match = /^\/mb03(?:@\w+)?(?:\s+(.+))?$/i.exec(text.trim());
  if (!match) return null;
  const warehouseName = clean(match[1] || "", 240);
  return { warehouseName: warehouseName || null };
}

export function parseMb03CancelCommand(text: string) {
  return /^\/mb03cancel(?:@\w+)?$/i.test(text.trim());
}

export function parseMb03StatusCommand(text: string) {
  return /^\/mb03status(?:@\w+)?$/i.test(text.trim());
}

export function parseMb03GateCommand(text: string) {
  return /^\/mb03gate(?:@\w+)?$/i.test(text.trim());
}

export function parseMb03ClassCommand(text: string): { caseId: string; decisionClass: Mb03DecisionClass } | null {
  const match = /^\/mb03class(?:@\w+)?\s+(MB03-[0-9]{8}-[0-9]{4})\s+([A-Z_]+)$/i.exec(text.trim());
  if (!match) return null;
  const decisionClass = match[2].toUpperCase() as Mb03DecisionClass;
  return MB03_DECISION_CLASSES.includes(decisionClass) ? { caseId: match[1].toUpperCase(), decisionClass } : null;
}

export function parseMb03ClassifyCommand(text: string) {
  return /^\/mb03classify(?:@\w+)?$/i.test(text.trim());
}

export function parseMb03RemediateCommand(text: string) {
  return /^\/mb03remediate(?:@\w+)?$/i.test(text.trim());
}

export function parseMb03AmendCommand(text: string): { caseId: string; field: "RULE_CHECK" | "CONTEXT_GAPS"; value: string; reason: string } | null {
  const match = /^\/mb03amend(?:@\w+)?\s+(MB03-[0-9]{8}-[0-9]{4})\s+(RULE_CHECK|CONTEXT_GAPS)\s+(NO|NONE)\s+(.+)$/i.exec(text.trim());
  if (!match) return null;
  const field = match[2].toUpperCase() as "RULE_CHECK" | "CONTEXT_GAPS";
  const value = match[3].toUpperCase();
  if ((field === "RULE_CHECK" && value !== "NO") || (field === "CONTEXT_GAPS" && value !== "NONE")) return null;
  const reason = clean(match[4], 1600);
  return reason ? { caseId: match[1].toUpperCase(), field, value, reason } : null;
}

const classTokens: Record<string, Mb03DecisionClass> = {
  P: "MULTI_STATUS_WAREHOUSE_PRIORITIZATION",
  C: "WAREHOUSE_CAPACITY_REALLOCATION",
  S: "SLA_VS_BACKLOG_PRIORITIZATION",
  R: "RE_ROUTE_HOLD_ESCALATE",
  O: "OTHER_REAL_CLASS",
  N: "NOT_A_TRUE_DECISION",
};

export function parseMb03ClassCallback(data: string | null | undefined): { caseId: string; decisionClass: Mb03DecisionClass } | null {
  const match = /^mb03:c:(MB03-[0-9]{8}-[0-9]{4}):([PCSRON])$/i.exec(String(data || ""));
  if (!match) return null;
  const decisionClass = classTokens[match[2].toUpperCase()];
  return decisionClass ? { caseId: match[1].toUpperCase(), decisionClass } : null;
}

export function mb03ClassKeyboard(caseId: string) {
  const choices: Array<[string, keyof typeof classTokens]> = [
    ["Ưu tiên đa trạng thái", "P"], ["Phân bổ capacity", "C"],
    ["SLA vs backlog", "S"], ["Đổi tuyến / giữ / escalate", "R"],
    ["Class khác", "O"], ["Không phải true decision", "N"],
  ];
  return Array.from({ length: 3 }, (_, index) => choices.slice(index * 2, index * 2 + 2)
    .map(([text, token]) => ({ text, callbackData: `mb03:c:${caseId}:${token}` })));
}

export function parseMb03OutcomeCommand(text: string): { caseId: string; classification: DiscoveryOutcome; evidence: string } | null {
  const match = /^\/mb03outcome(?:@\w+)?\s+(MB03-[0-9]{8}-[0-9]{4})\s+(SUCCESS|FAILURE|INCONCLUSIVE)\s+(.+)$/i.exec(text.trim());
  return match ? { caseId: match[1].toUpperCase(), classification: match[2].toUpperCase() as DiscoveryOutcome, evidence: clean(match[3], 2000) } : null;
}

const quickReplyValues: Partial<Record<DiscoveryStep, Record<string, string>>> = {
  PLAYBOOK_FIT: { COVERED: "COVERED", OUTSIDE: "OUTSIDE" },
  RULE_CHECK: { YES: "YES - rule hiện tại đủ an toàn", NO: "NO - cần Manager cân nhắc" },
  CONTEXT_GAPS: { NONE: "NONE" },
  AUTHORITY: { YES: "YES", NO: "NO" },
  WINDOW_HOURS: { "1": "1", "2": "2", "4": "4", "8": "8", "24": "24" },
  MANAGER_THINKING: { ZERO: "ZERO", LOW: "LOW", HIGH: "MEDIUM/HIGH" },
};

export function parseMb03QuickReplyCallback(data: string | null | undefined): { step: DiscoveryStep; value: string } | null {
  const match = /^mb03:q:([A-Z_]+):([A-Z0-9]+)$/.exec(String(data || ""));
  if (!match) return null;
  const step = match[1] as DiscoveryStep;
  const value = quickReplyValues[step]?.[match[2]];
  return value ? { step, value } : null;
}

export function discoveryQuickReplyKeyboard(step: DiscoveryStep | null) {
  if (!step) return [];
  const labels: Partial<Record<DiscoveryStep, Array<[string, string]>>> = {
    PLAYBOOK_FIT: [["COVERED — theo playbook", "COVERED"], ["OUTSIDE — ngoài playbook", "OUTSIDE"]],
    RULE_CHECK: [["YES — rule đủ", "YES"], ["NO — cần Manager", "NO"]],
    CONTEXT_GAPS: [["NONE — đủ context", "NONE"]],
    AUTHORITY: [["YES — có quyền", "YES"], ["NO — không có quyền", "NO"]],
    WINDOW_HOURS: [["1h", "1"], ["2h", "2"], ["4h", "4"], ["8h", "8"], ["24h", "24"]],
    MANAGER_THINKING: [["ZERO", "ZERO"], ["LOW", "LOW"], ["MEDIUM/HIGH", "HIGH"]],
  };
  const buttons = (labels[step] || []).map(([text, token]) => ({ text, callbackData: `mb03:q:${step}:${token}` }));
  return Array.from({ length: Math.ceil(buttons.length / 2) }, (_, index) => buttons.slice(index * 2, index * 2 + 2));
}

function formatVietnamTime(value: string) {
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

export function outcomeTimeGate(outcomeDueAt: string | undefined, now = new Date()): string | null {
  const due = Date.parse(String(outcomeDueAt || ""));
  if (!Number.isFinite(due) || now.getTime() >= due) return null;
  const remainingMinutes = Math.max(1, Math.ceil((due - now.getTime()) / 60_000));
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  return `Chưa đến thời điểm ghi outcome. Chỉ được ghi từ ${formatVietnamTime(new Date(due).toISOString())} (còn ${hours ? `${hours} giờ ` : ""}${minutes} phút). Hãy kiểm tra snapshot mới rồi thử lại.`;
}

export function createMb03DiscoveryState(input: { warehouseName: string; chatId: string; messageThreadId: number | null; now?: Date }): Mb03DiscoveryState {
  const now = input.now || new Date();
  const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(now).reduce<Record<string, string>>((out, item) => (out[item.type] = item.value, out), {});
  return {
    type: MB03_DISCOVERY_TYPE,
    version: "MB03_DISCOVERY_V2",
    sessionId: randomUUID(),
    caseId: `MB03-${stamp.year}${stamp.month}${stamp.day}-${stamp.hour}${stamp.minute}`,
    scopeCode: MB03_SCOPE_CODE,
    warehouseName: clean(input.warehouseName, 240),
    status: "ACTIVE",
    step: "PLAYBOOK_FIT",
    answers: {},
    chatId: input.chatId,
    messageThreadId: input.messageThreadId,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function validateDiscoveryReply(step: DiscoveryStep, text: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = clean(text);
  if (!value) return { ok: false, message: "Câu trả lời trống. Hãy Reply lại tin nhắn câu hỏi." };
  if (step === "WINDOW_HOURS") {
    const hours = Number(value);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) return { ok: false, message: "Cửa sổ đo phải là số giờ nguyên từ 1 đến 168." };
    return { ok: true, value: String(hours) };
  }
  if (step === "PLAYBOOK_FIT" && !/^(COVERED|OUTSIDE)$/i.test(value)) return { ok: false, message: "Chỉ chọn COVERED hoặc OUTSIDE." };
  if (step === "AUTHORITY" && !/^(YES|NO)(?:\b|\s|[.,:-])/i.test(value)) return { ok: false, message: "Hãy bắt đầu câu trả lời bằng YES hoặc NO." };
  if (step === "RULE_CHECK" && !/^(YES|NO)(?:\b|\s|[.,:-])/i.test(value)) return { ok: false, message: "Hãy bắt đầu câu trả lời bằng YES hoặc NO, sau đó nêu lý do." };
  if (step === "MANAGER_THINKING" && !/^(ZERO|LOW|MEDIUM\/HIGH)$/i.test(value)) return { ok: false, message: "Chỉ chọn ZERO, LOW hoặc MEDIUM/HIGH." };
  return { ok: true, value };
}

export function advanceMb03Discovery(state: Mb03DiscoveryState, reply: string, now = new Date()): { state: Mb03DiscoveryState; prompt: string; completed: boolean } | { error: string } {
  if (state.status !== "ACTIVE" || !state.step) return { error: "Discovery session không còn nhận câu trả lời." };
  const valid = validateDiscoveryReply(state.step, reply);
  if (!valid.ok) return { error: valid.message };
  const answers = { ...state.answers, [state.step]: valid.value };
  const currentStep = state.step;
  const next = currentStep === "PLAYBOOK_FIT"
    ? valid.value === "COVERED" ? "PLAYBOOK_ACTION" : "GAP_EXPLANATION"
    : currentStep === "GAP_EXPLANATION" ? "PROBLEM"
    : currentStep === "PLAYBOOK_ACTION" ? "WINDOW_HOURS"
    : currentStep === "WINDOW_HOURS" && answers.PLAYBOOK_FIT === "COVERED" ? null
    : trueDecisionSteps[trueDecisionSteps.indexOf(currentStep) + 1] || null;
  if (next) return { state: { ...state, answers, step: next, updatedAt: now.toISOString() }, prompt: prompts[next], completed: false };
  const hours = Number(answers.WINDOW_HOURS || 0);
  const outcomeDueAt = new Date(now.getTime() + hours * 3_600_000).toISOString();
  const lane: Mb03DiscoveryLane = answers.PLAYBOOK_FIT === "COVERED" ? "ROUTINE_TRIAGE" : "TRUE_DECISION";
  const authorityOk = /^YES\b/i.test(answers.AUTHORITY || "");
  const noContextGap = /^(NONE|NO|KHONG|KHÔNG)\b/i.test(answers.CONTEXT_GAPS || "");
  const ruleInsufficient = /^NO\b/i.test(answers.RULE_CHECK || "");
  const classification = lane === "ROUTINE_TRIAGE" ? "PLAYBOOK_TRIAGE" : !authorityOk || !noContextGap ? "CONTEXT_GAP" : !ruleInsufficient ? "DETERMINISTIC_OR_RULE_REVIEW" : "CANDIDATE_REVIEW_REQUIRED";
  const completedState: Mb03DiscoveryState = { ...state, answers, lane, step: null, status: "AWAITING_OUTCOME", outcomeDueAt, updatedAt: now.toISOString() };
  const summary = [
    `MB03 DISCOVERY CAPTURED — ${state.caseId}`,
    `Kho: ${state.warehouseName}`,
    `Phân loại sơ bộ: ${classification}`,
    lane === "ROUTINE_TRIAGE" ? `Action kiểm tra: ${answers.PLAYBOOK_ACTION}` : `Option A: ${answers.OPTION_A}`,
    lane === "ROUTINE_TRIAGE" ? "Lane: routine triage — không tính vào C2." : `Option B: ${answers.OPTION_B}`,
    lane === "TRUE_DECISION" ? `Trade-off: ${answers.TRADE_OFF}` : "",
    lane === "TRUE_DECISION" ? `Context gap: ${answers.CONTEXT_GAPS}` : "",
    `Chỉ ghi outcome từ: ${formatVietnamTime(outcomeDueAt)}`,
    "Không approval, không work order, không điều phối.",
    `Khi có kết quả: /mb03outcome ${state.caseId} SUCCESS|FAILURE|INCONCLUSIVE <evidence>`
  ].filter(Boolean).join("\n");
  return { state: completedState, prompt: summary, completed: true };
}

export function discoveryPrompt(step: DiscoveryStep) { return prompts[step]; }

type ManagerContext = { memberId: string; telegramUserId: number; chatId: string; chatType: string; messageThreadId: number | null; provinceName?: string | null };

type DiscoveryOrderEvidence = {
  reasonName: string;
  affectedOrderCount: number;
  maximumAgeHours: number | null;
  orderCodes: string[];
};

type IncidentHistoryEvidenceRow = {
  incident_id: string;
  affected_order_count: number;
  maximum_age_hours: number | null;
  sample_order_codes: unknown;
};

type Mb03Warehouse = { warehouseId: string; warehouseName: string; zone: string };
type DiscoveryCandidate = DiscoveryOrderEvidence & {
  incidentId: string;
  incidentKey: string;
  incidentSnapshotKey: string;
  warehouseName: string;
  reasonCode: string;
};

/** The incident queue is an aggregated signal, not a root-cause verdict.
 * This gives the manager the precise playbook conditions to verify before
 * choosing COVERED or OUTSIDE; it never invents an operational route. */
export function mb03PlaybookPrecheck(reasonCode: string, warehouseName: string) {
  const common = "Dùng mã đơn mẫu để kiểm timeline thực tế; không tự đổi trạng thái hay điều phối.";
  switch (reasonCode) {
    case "KHO_CHUA_LAY": return [
      "Pre-check: tín hiệu Kho chưa lấy chưa tự xác nhận root cause.",
      "Đối chiếu: createdAt → endPickAt có vượt 24h; kho lấy và checkpoint bàn giao kế tiếp.",
      `Nếu đúng: PICKUP_COMPLETION_DELAY — kiểm tra tại kho lấy/bàn giao; ${common}`,
    ].join("\n");
    case "KHO_CHUA_LUAN_CHUYEN": return [
      "Pre-check: cần xác định KCT, COT 07:00 áp dụng và kho kế tiếp trước khi quy action.",
      "Đối chiếu: thời điểm nhập KCT, COT áp dụng, chưa xuất, và next warehouse trong timeline.",
      "Đích hub: TRANSIT_TO_HUB_NOT_EXPORTED — KCT xử lý xuất. Đích kho GHN: TRANSIT_TO_GHN_NOT_EXPORTED — kho GHN đích làm việc lại với KCT. Thiếu đích: TRANSIT_WAREHOUSE_NOT_EXPORTED — chỉ xác minh đích, chưa quy action.", common,
    ].join("\n");
    case "KHO_TON": return [
      "Pre-check: Kho tồn là tín hiệu tổng hợp, chưa đủ để chọn một rule.",
      `Đối chiếu tại ${warehouseName}: loại kho, thời điểm nhập/xuất, COT 07:00, trạng thái giao và kho kế tiếp.`,
      "KHL tồn ≥24h: KEY_ACCOUNT_WAREHOUSE_LONG_DWELL. GHN qua COT chưa xuất: GHN_MISSED_0700_COT. Nhận sáng nhưng chưa gán giao: GHN_MORNING_INTAKE_NOT_ASSIGNED_DELIVERY. Thiếu checkpoint: CONTEXT_GAP, chưa kết luận.", common,
    ].join("\n");
    case "THIEU_SHIPPER": return [
      "Pre-check: playbook chưa có rule kết luận riêng cho tín hiệu Thiếu shipper.",
      "Đối chiếu: ca làm, số đơn đã gán/chưa gán, trạng thái đơn và checkpoint xuất giao; không dùng nhận định miệng thay evidence.",
      "Nếu timeline đồng thời khớp rule GHN/COT có sẵn thì theo rule đó. Nếu đủ evidence mà không khớp rule nào: ghi PLAYBOOK_GAP để Operations Manager cung cấp nguyên nhân/action chuẩn; chưa phải True Decision mặc định.", common,
    ].join("\n");
    default: return [
      "Pre-check: chưa có map trực tiếp từ tín hiệu incident sang playbook.",
      "Đối chiếu: trạng thái realtime, checkpoint nhập/xuất, thời gian tồn từng chặng, kho kế tiếp và loại đơn.",
      "Chỉ chọn OUTSIDE sau khi timeline đầy đủ mà vẫn không khớp rule nào; khi đó ghi PLAYBOOK_GAP, không tự đặt action.", common,
    ].join("\n");
  }
}

const mb03Warehouses = (warehouseAssignments.warehouses as Mb03Warehouse[]).filter((warehouse) => warehouse.zone === "Miền Bắc 3");
const mb03WarehouseIds = mb03Warehouses.map((warehouse) => warehouse.warehouseId);

function warehouseKey(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

export function resolveMb03ProvinceWarehouseIds(provinceName: string | null | undefined) {
  if (!provinceName) return mb03WarehouseIds;
  const province = warehouseKey(provinceName);
  return mb03Warehouses.filter((warehouse) => warehouseKey((warehouse as Mb03Warehouse & { province?: string }).province || "") === province).map((warehouse) => warehouse.warehouseId);
}

function resolvePreferredWarehouseId(value: string | null) {
  if (!value) return null;
  const wanted = warehouseKey(value);
  return mb03Warehouses.find((warehouse) => {
    const candidate = warehouseKey(warehouse.warehouseName);
    return candidate === wanted || candidate.includes(wanted) || wanted.includes(candidate);
  })?.warehouseId || null;
}

export function formatDiscoveryOrderEvidence(items: DiscoveryOrderEvidence[]) {
  const codes = [...new Set(items.flatMap((item) => item.orderCodes))].slice(0, 10);
  if (!codes.length) return "Mã đơn cần check: chưa có mã mẫu trong snapshot hiện tại. Hãy bổ sung mã đơn thực tế khi Reply.";
  const findings = items.slice(0, 3).map((item) => {
    const age = item.maximumAgeHours == null ? "chưa rõ tuổi tồn" : `tối đa ${Math.round(item.maximumAgeHours)}h`;
    return `- ${item.reasonName}: ${item.affectedOrderCount} đơn, ${age}`;
  });
  return [
    "Mã đơn cần check:",
    ...codes.map((code) => `- ${code}`),
    "Bằng chứng snapshot:",
    ...findings,
    "Chỉ dùng để kiểm tra timeline/trạng thái; không tự thay đổi trạng thái đơn.",
  ].join("\n");
}

export function orderCodeCopyKeyboard(orderCodes: string[]) {
  const buttons = [...new Set(orderCodes)].slice(0, 10).map((code) => ({ text: `Copy ${code}`, copyText: code }));
  return Array.from({ length: Math.ceil(buttons.length / 2) }, (_, index) => buttons.slice(index * 2, index * 2 + 2));
}

export class TelegramMb03DiscoveryService {
  constructor(private readonly client: SupabaseClient, private readonly telegram = new TelegramClient()) {}

  private async latest(memberId: string, caseId?: string): Promise<{ state: Mb03DiscoveryState; promptMessageId: number | null } | null> {
    let query = this.client.from("conversation_events").select("telegram_message_id, ai_result, created_at")
      .eq("member_id", memberId).eq("direction", "OUTBOUND").contains("ai_result", { type: MB03_DISCOVERY_TYPE });
    if (caseId) query = query.contains("ai_result", { caseId });
    const { data, error } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data?.ai_result ? { state: data.ai_result as Mb03DiscoveryState, promptMessageId: Number(data.telegram_message_id) || null } : null;
  }

  private async persistOutbound(ctx: ManagerContext, state: Mb03DiscoveryState, text: string, orderCodes: string[] = []) {
    const inlineKeyboard = [
      ...orderCodeCopyKeyboard(orderCodes),
      ...discoveryQuickReplyKeyboard(state.step),
    ];
    const sent = await this.telegram.sendToChat(ctx.chatId, text, {
      messageThreadId: ctx.messageThreadId,
      ...(inlineKeyboard.length ? { inlineKeyboard } : {}),
    });
    const { error } = await this.client.from("conversation_events").insert({
      member_id: ctx.memberId, telegram_user_id: ctx.telegramUserId, telegram_message_id: Number(sent.messageId), direction: "OUTBOUND",
      text: text.slice(0, 8000), source_chat_type: ctx.chatType, ai_result: state,
    });
    if (error) throw error;
    return sent.messageId;
  }

  private async persistInbound(ctx: ManagerContext, updateId: number, messageId: number, replyToMessageId: number | null, text: string, state: Mb03DiscoveryState) {
    const { error } = await this.client.from("conversation_events").insert({
      member_id: ctx.memberId, telegram_user_id: ctx.telegramUserId, telegram_message_id: messageId, direction: "INBOUND",
      text: text.slice(0, 8000), reply_to_message_id: replyToMessageId, source_chat_type: ctx.chatType,
      telegram_update_id: updateId, ai_result: { ...state, receivedText: text.slice(0, 2000) },
    });
    if (error) throw error;
  }

  private async nextCase(preferredWarehouseName: string | null, provinceName?: string | null): Promise<DiscoveryCandidate | null> {
    const preferredWarehouseId = resolvePreferredWarehouseId(preferredWarehouseName);
    const scopedWarehouseIds = resolveMb03ProvinceWarehouseIds(provinceName);
    if (!scopedWarehouseIds.length) return null;
    let incidentQuery = this.client.from("incidents")
      .select("id, incident_key, warehouse_id, warehouse_name, reason_code, reason_name, priority_score, last_detected_at")
      .in("warehouse_id", scopedWarehouseIds)
      .in("status", ["open", "monitoring"])
      .order("priority_score", { ascending: false })
      .order("last_detected_at", { ascending: false })
      .limit(200);
    if (preferredWarehouseId) incidentQuery = incidentQuery.eq("warehouse_id", preferredWarehouseId);
    const { data: incidents, error: incidentError } = await incidentQuery;
    if (incidentError) throw incidentError;
    if (!incidents?.length) return null;

    const { data: histories, error: historyError } = await this.client.from("incident_history")
      .select("incident_id, affected_order_count, maximum_age_hours, sample_order_codes, recorded_at")
      .in("incident_id", incidents.map((incident) => incident.id))
      .order("recorded_at", { ascending: false });
    if (historyError) throw historyError;
    const { data: priorEvents, error: priorError } = await this.client.from("conversation_events")
      .select("ai_result")
      .eq("direction", "OUTBOUND")
      .contains("ai_result", { type: MB03_DISCOVERY_TYPE })
      .order("created_at", { ascending: false })
      .limit(500);
    if (priorError) throw priorError;
    const alreadySent = new Set((priorEvents || []).map((event) => String(event.ai_result?.incidentSnapshotKey || "")).filter(Boolean));
    const latestByIncident = new Map<string, IncidentHistoryEvidenceRow>();
    for (const history of histories || []) if (!latestByIncident.has(String(history.incident_id))) latestByIncident.set(String(history.incident_id), history as IncidentHistoryEvidenceRow);
    const candidates = incidents.map((incident) => {
      const history = latestByIncident.get(String(incident.id));
      return {
        incidentId: String(incident.id),
        incidentKey: String(incident.incident_key),
        incidentSnapshotKey: `${incident.id}:${incident.last_detected_at}`,
        warehouseName: String(incident.warehouse_name || "Kho chưa xác định"),
        reasonName: String(incident.reason_name || "Sự cố vận hành"),
        reasonCode: String(incident.reason_code || "UNKNOWN"),
        affectedOrderCount: Number(history?.affected_order_count || 0),
        maximumAgeHours: history?.maximum_age_hours == null ? null : Number(history.maximum_age_hours),
        orderCodes: Array.isArray(history?.sample_order_codes)
          ? history.sample_order_codes.filter((code: unknown): code is string => typeof code === "string" && Boolean(code.trim()))
          : [],
      };
    }).filter((item) => item.orderCodes.length > 0);
    return candidates.find((candidate) => !alreadySent.has(candidate.incidentSnapshotKey)) || null;
  }

  async start(ctx: ManagerContext, preferredWarehouseName: string | null) {
    const current = await this.latest(ctx.memberId);
    if (current?.state.status === "ACTIVE") return { ok: false, message: `Đang có case ${current.state.caseId} trong topic ${current.state.provinceName || "khác"}. Hãy hoàn tất hoặc hủy tại đúng topic đó.` };
    if (ctx.messageThreadId && !ctx.provinceName) return { ok: false, message: "Topic này chưa được map tỉnh trên Telegram Pilot. Hãy map tỉnh trước khi dùng /mb03 để tránh trộn case." };
    const candidate = await this.nextCase(preferredWarehouseName, ctx.provinceName);
    if (!candidate) return { ok: false, message: preferredWarehouseName
      ? `Không còn snapshot mới có mã đơn cho kho đã chọn trong phạm vi ${ctx.provinceName || "MB03"}.`
      : `Hiện không còn snapshot mới có mã đơn để xử lý trong phạm vi ${ctx.provinceName || "MB03"}.` };
    const state: Mb03DiscoveryState = {
      ...createMb03DiscoveryState({ warehouseName: candidate.warehouseName, chatId: ctx.chatId, messageThreadId: ctx.messageThreadId }),
      incidentId: candidate.incidentId,
      incidentKey: candidate.incidentKey,
      incidentSnapshotKey: candidate.incidentSnapshotKey,
      reasonName: candidate.reasonName,
      reasonCode: candidate.reasonCode,
      orderCodes: candidate.orderCodes.slice(0, 10),
      ...(ctx.provinceName ? { provinceName: ctx.provinceName } : {}),
    };
    const evidence = formatDiscoveryOrderEvidence([candidate]);
    const precheck = mb03PlaybookPrecheck(candidate.reasonCode, candidate.warehouseName);
    await this.persistOutbound(ctx, state, `MB03 TRIAGE — ${state.caseId}\nPhạm vi topic: ${ctx.provinceName || "Toàn MB03"}\nIncident: ${candidate.incidentKey}\nKho cần xử lý: ${state.warehouseName}\nTín hiệu: ${candidate.reasonName}\n${evidence}\n\nHƯỚNG ĐỐI CHIẾU PLAYBOOK\n${precheck}\n\nBấm nút Copy bên dưới để chép từng mã đơn. Chọn COVERED khi evidence xác nhận một hướng trên; chọn OUTSIDE chỉ sau khi timeline đủ mà không khớp hướng nào.\n\n${discoveryPrompt("PLAYBOOK_FIT")}`, candidate.orderCodes);
    return { ok: true, message: `Đã bắt đầu ${state.caseId}. Hãy Reply vào câu hỏi của bot.` };
  }

  async reply(ctx: ManagerContext, input: { updateId: number; messageId: number; replyToMessageId: number; text: string }) {
    const current = await this.latest(ctx.memberId);
    if (!current || current.state.status !== "ACTIVE" || current.promptMessageId !== input.replyToMessageId) return { handled: false };
    if (current.state.chatId !== ctx.chatId || current.state.messageThreadId !== ctx.messageThreadId) return { handled: false };
    const advanced = advanceMb03Discovery(current.state, input.text);
    if ("error" in advanced) return { handled: true, ok: false, message: advanced.error };
    await this.persistInbound(ctx, input.updateId, input.messageId, input.replyToMessageId, input.text, current.state);
    await this.persistOutbound(ctx, advanced.state, advanced.prompt);
    return { handled: true, ok: true, completed: advanced.completed };
  }

  async cancel(ctx: ManagerContext) {
    const current = await this.latest(ctx.memberId);
    if (!current || current.state.status !== "ACTIVE") return { ok: false, message: "Không có MB03 discovery đang hoạt động." };
    if (current.state.chatId !== ctx.chatId || current.state.messageThreadId !== ctx.messageThreadId) return { ok: false, message: `Case ${current.state.caseId} thuộc topic ${current.state.provinceName || "khác"}. Hãy hủy tại đúng topic.` };
    const state = { ...current.state, status: "CANCELLED" as const, step: null, updatedAt: new Date().toISOString() };
    await this.persistOutbound(ctx, state, `Đã hủy ${state.caseId}. Không decision/work order nào được tạo.`);
    return { ok: true, message: `Đã hủy ${state.caseId}.` };
  }

  async status(ctx: ManagerContext) {
    const { data, error } = await this.client.from("conversation_events").select("ai_result,created_at")
      .eq("member_id", ctx.memberId).eq("direction", "OUTBOUND")
      .contains("ai_result", { type: MB03_DISCOVERY_TYPE }).order("created_at", { ascending: false }).limit(500);
    if (error) throw error;
    const latest = new Map<string, Mb03DiscoveryState>();
    for (const event of data || []) {
      const state = event.ai_result as Mb03DiscoveryState | null;
      if (!state?.caseId || state.type !== MB03_DISCOVERY_TYPE) continue;
      const existing = latest.get(state.caseId);
      if (!existing || Date.parse(state.updatedAt) >= Date.parse(existing.updatedAt)) latest.set(state.caseId, state);
    }
    const cases = [...latest.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const pending = cases.filter((item) => item.status === "ACTIVE" || item.status === "AWAITING_OUTCOME");
    const now = Date.now();
    const lines = pending.slice(0, 15).map((item) => item.status === "AWAITING_OUTCOME"
      ? `- ${item.caseId} · ${item.warehouseName} · chờ outcome ${item.outcomeDueAt && Date.parse(item.outcomeDueAt) <= now ? "(đã đến hạn)" : "(chưa đến hạn)"}`
      : `- ${item.caseId} · ${item.warehouseName} · đang trả lời bước ${item.step || "?"}`);
    const message = [
      "MB03 STATUS",
      `Tổng: ${cases.length} · Pending: ${pending.length} · Completed: ${cases.filter((item) => item.status === "COMPLETED").length} · Cancelled: ${cases.filter((item) => item.status === "CANCELLED").length}`,
      lines.length ? "Case cần xử lý:\n" + lines.join("\n") : "Không có case MB03 nào đang pending.",
      lines.some((line) => line.includes("chờ outcome")) ? "Ghi outcome tại đúng topic: /mb03outcome <case-id> SUCCESS|FAILURE|INCONCLUSIVE <evidence>" : "",
    ].filter(Boolean).join("\n");
    const sent = await this.telegram.sendToChat(ctx.chatId, message, { messageThreadId: ctx.messageThreadId });
    const { error: persistError } = await this.client.from("conversation_events").insert({ member_id: ctx.memberId, telegram_user_id: ctx.telegramUserId, telegram_message_id: Number(sent.messageId), direction: "OUTBOUND", text: message, source_chat_type: ctx.chatType, ai_result: { type: "MB03_DISCOVERY_STATUS", generatedAt: new Date().toISOString() } });
    if (persistError) throw persistError;
    return { pending: pending.length, completed: cases.filter((item) => item.status === "COMPLETED").length };
  }

  private async allCasesForMember(memberId: string) {
    const { data, error } = await this.client.from("conversation_events").select("ai_result,created_at")
      .eq("member_id", memberId).eq("direction", "OUTBOUND")
      .contains("ai_result", { type: MB03_DISCOVERY_TYPE }).order("created_at", { ascending: false }).limit(1000);
    if (error) throw error;
    const latest = new Map<string, Mb03DiscoveryState>();
    for (const event of data || []) {
      const state = event.ai_result as Mb03DiscoveryState | null;
      if (!state?.caseId || state.type !== MB03_DISCOVERY_TYPE) continue;
      const existing = latest.get(state.caseId);
      if (!existing || Date.parse(state.updatedAt) >= Date.parse(existing.updatedAt)) latest.set(state.caseId, state);
    }
    return [...latest.values()];
  }

  async classify(ctx: ManagerContext, input: { caseId: string; decisionClass: Mb03DecisionClass }) {
    const cases = await this.allCasesForMember(ctx.memberId);
    const current = cases.find((item) => item.caseId === input.caseId);
    if (!current || current.status !== "COMPLETED" || current.lane !== "TRUE_DECISION") return { ok: false, message: "Chỉ gán class cho case TRUE_DECISION đã COMPLETED của chính bạn." };
    if (current.chatId !== ctx.chatId || current.messageThreadId !== ctx.messageThreadId) return { ok: false, message: "Hãy gán class tại đúng topic đã tạo case để giữ audit rõ ràng." };
    const state = { ...current, decisionClass: input.decisionClass, updatedAt: new Date().toISOString() };
    await this.persistOutbound(ctx, state, `Đã gán ${input.decisionClass} cho ${input.caseId}. Đây là nhãn Manager xác nhận để gom gate; không tạo Decision/work order.`);
    return { ok: true, message: `Đã gán class cho ${input.caseId}.` };
  }

  async sendClassificationPrompts(ctx: ManagerContext) {
    const cases = (await this.allCasesForMember(ctx.memberId)).filter((item) => item.status === "COMPLETED" && item.lane === "TRUE_DECISION" && !item.decisionClass);
    let sent = 0;
    for (const state of cases) {
      const answers = state.answers;
      const message = [
        `MB03 CLASSIFY — ${state.caseId}`,
        `Kho: ${state.warehouseName}`,
        `Vấn đề: ${answers.PROBLEM || "chưa ghi"}`,
        `Nguồn lực: ${answers.RESOURCE || "chưa ghi"}`,
        `Option A: ${answers.OPTION_A || "chưa ghi"}`,
        `Option B: ${answers.OPTION_B || "chưa ghi"}`,
        `Trade-off: ${answers.TRADE_OFF || "chưa ghi"}`,
        `Action: ${answers.ACTION || "chưa ghi"}`,
        `Baseline: ${answers.BASELINE || "chưa ghi"}`,
        `Outcome: ${state.outcome?.classification || "chưa ghi"} — ${state.outcome?.evidence || "chưa có evidence"}`,
        "Chọn class phản ánh quyết định thực tế. Đây chỉ là nhãn gom case, không tạo decision/work order.",
      ].join("\n");
      const delivery = await this.telegram.sendToChat(state.chatId, message, { messageThreadId: state.messageThreadId, inlineKeyboard: mb03ClassKeyboard(state.caseId) });
      const promptState = { ...state, classificationPromptSentAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const { error } = await this.client.from("conversation_events").insert({ member_id: ctx.memberId, telegram_user_id: ctx.telegramUserId, telegram_message_id: Number(delivery.messageId), direction: "OUTBOUND", text: message, source_chat_type: ctx.chatType, ai_result: promptState });
      if (error) throw error;
      sent += 1;
    }
    return { sent, skipped: (await this.allCasesForMember(ctx.memberId)).filter((item) => item.status === "COMPLETED" && item.lane === "TRUE_DECISION" && Boolean(item.decisionClass)).length };
  }

  async sendRemediationPrompts(ctx: ManagerContext) {
    const cases = (await this.allCasesForMember(ctx.memberId)).filter((item) => item.status === "COMPLETED" && item.lane === "TRUE_DECISION" && item.chatId === ctx.chatId && item.messageThreadId === ctx.messageThreadId);
    let sent = 0;
    for (const state of cases) {
      const ruleNeedsReview = !/^NO\b/i.test(state.answers.RULE_CHECK || "");
      const contextNeedsReview = !/^(NONE|NO|KHONG|KHÔNG)\b/i.test(state.answers.CONTEXT_GAPS || "");
      if (!ruleNeedsReview && !contextNeedsReview) continue;
      const correction = [
        `MB03 EVIDENCE REVIEW — ${state.caseId}`,
        ruleNeedsReview ? `Rule đã ghi: ${state.answers.RULE_CHECK || "chưa có"}` : "Rule: đã đạt điều kiện.",
        contextNeedsReview ? `Context đã ghi: ${state.answers.CONTEXT_GAPS || "chưa có"}` : "Context: đã đạt điều kiện.",
        "Chỉ bổ sung nếu bản ghi ban đầu sai hoặc đã có evidence tại thời điểm ra quyết định. Không đổi câu trả lời để vượt gate.",
        ruleNeedsReview ? `Nếu đúng là rule không đủ: /mb03amend ${state.caseId} RULE_CHECK NO <evidence lý do>` : "",
        contextNeedsReview ? `Nếu thực tế không thiếu context: /mb03amend ${state.caseId} CONTEXT_GAPS NONE <evidence nguồn context>` : "",
        "Nếu bản ghi ban đầu đúng, không cần phản hồi; case này không phải mẫu true decision cho C2.",
      ].filter(Boolean).join("\n");
      const promptState = { ...state, remediationPromptSentAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await this.persistOutbound(ctx, promptState, correction);
      sent += 1;
    }
    return { sent };
  }

  async amend(ctx: ManagerContext, input: { caseId: string; field: "RULE_CHECK" | "CONTEXT_GAPS"; value: string; reason: string }) {
    const cases = await this.allCasesForMember(ctx.memberId);
    const current = cases.find((item) => item.caseId === input.caseId);
    if (!current || current.status !== "COMPLETED") return { ok: false, message: "Chỉ bổ sung evidence cho case MB03 đã COMPLETED của chính bạn." };
    if (current.chatId !== ctx.chatId || current.messageThreadId !== ctx.messageThreadId) return { ok: false, message: "Hãy bổ sung evidence tại đúng topic đã tạo case để giữ audit rõ ràng." };
    const value = input.field === "RULE_CHECK" ? `NO - ${input.reason}` : `NONE - ${input.reason}`;
    const now = new Date().toISOString();
    const state: Mb03DiscoveryState = {
      ...current,
      answers: { ...current.answers, [input.field]: value },
      amendments: { ...current.amendments, [input.field]: { value: input.value, reason: input.reason, recordedAt: now } },
      updatedAt: now,
    };
    await this.persistOutbound(ctx, state, `Đã bổ sung evidence ${input.field} cho ${input.caseId}: ${input.value}. Bản ghi gốc vẫn được giữ trong audit; đây không phải approval/work order.`);
    return { ok: true, message: `Đã bổ sung evidence cho ${input.caseId}.` };
  }

  async gate(ctx: ManagerContext) {
    const completed = (await this.allCasesForMember(ctx.memberId)).filter((item) => item.status === "COMPLETED");
    const cases = completed.filter((item) => item.lane === "TRUE_DECISION");
    const invalidReasons = (item: Mb03DiscoveryState) => {
      const answers = item.answers;
      const reasons: string[] = [];
      if (!item.outcome) reasons.push("chưa có outcome");
      const missing = ["PROBLEM", "RESOURCE", "OPTION_A", "OPTION_B", "TRADE_OFF", "ACTION", "BASELINE", "OUTCOME_RULE"].filter((key) => !answers[key as DiscoveryStep]);
      if (missing.length) reasons.push(`thiếu ${missing.join(",")}`);
      if (!/^NO\b/i.test(answers.RULE_CHECK || "")) reasons.push("rule vẫn đủ/không rõ");
      if (!/^(NONE|NO|KHONG|KHÔNG)\b/i.test(answers.CONTEXT_GAPS || "")) reasons.push("còn context gap");
      if (!/^YES\b/i.test(answers.AUTHORITY || "")) reasons.push("chưa xác nhận thẩm quyền");
      if (!item.decisionClass) reasons.push("chưa có class");
      if (item.decisionClass === "NOT_A_TRUE_DECISION") reasons.push("đã đánh dấu không phải true decision");
      return reasons;
    };
    const invalid = cases.map((item) => ({ item, reasons: invalidReasons(item) }));
    const valid = invalid.filter(({ reasons }) => reasons.length === 0).map(({ item }) => item);
    const contextReady = cases.filter((item) => /^(NONE|NO|KHONG|KHÔNG)\b/i.test(item.answers.CONTEXT_GAPS || "")).length;
    const managerThinkingLow = cases.filter((item) => /^(ZERO|LOW)$/i.test(item.answers.MANAGER_THINKING || "")).length;
    const classes = new Map<string, number>();
    for (const item of valid) if (item.decisionClass) classes.set(item.decisionClass, (classes.get(item.decisionClass) || 0) + 1);
    const topClass = [...classes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const ratio = (count: number) => cases.length ? Math.round((count / cases.length) * 100) : 0;
    const checks = [
      `Routine triage đã hoàn tất: ${completed.filter((item) => item.lane !== "TRUE_DECISION").length} (không tính C2)`,
      `True decision hoàn tất: ${cases.length}/10 ${cases.length >= 10 ? "PASS" : "NOT YET"}`,
      `Case hợp lệ: ${valid.length}/7 ${valid.length >= 7 ? "PASS" : "NOT YET"}`,
      `Context đủ: ${contextReady}/${cases.length} (${ratio(contextReady)}%) ${ratio(contextReady) >= 80 ? "PASS" : "NOT YET"}`,
      `Manager thinking ZERO/LOW: ${managerThinkingLow}/${cases.length} (${ratio(managerThinkingLow)}%) ${ratio(managerThinkingLow) >= 80 ? "PASS" : "NOT YET"}`,
      `Class lặp lại: ${topClass ? `${topClass[0]} · ${topClass[1]}/5` : "chưa có"} ${topClass && topClass[1] >= 5 ? "PASS" : "NOT YET"}`,
    ];
    const missingClass = cases.filter((item) => !item.decisionClass).map((item) => item.caseId);
    const rejected = invalid.filter(({ reasons }) => reasons.length).slice(0, 20).map(({ item, reasons }) => `- ${item.caseId}: ${reasons.join("; ")}`);
    const message = ["MB03 GATE — advisory, không phải chứng nhận Level C", ...checks, missingClass.length ? `Cần gán class: ${missingClass.join(", ")}` : "Tất cả case đã có class.", rejected.length ? `Lý do chưa hợp lệ:\n${rejected.join("\n")}` : "Không có case bị loại.", "Chỉ mở C2 sau khi mọi gate PASS."].join("\n");
    const sent = await this.telegram.sendToChat(ctx.chatId, message, { messageThreadId: ctx.messageThreadId });
    const { error } = await this.client.from("conversation_events").insert({ member_id: ctx.memberId, telegram_user_id: ctx.telegramUserId, telegram_message_id: Number(sent.messageId), direction: "OUTBOUND", text: message, source_chat_type: ctx.chatType, ai_result: { type: "MB03_GATE_STATUS", generatedAt: new Date().toISOString() } });
    if (error) throw error;
    return { valid: valid.length, topClass: topClass?.[0] || null };
  }

  async recordOutcome(ctx: ManagerContext, input: { updateId: number; messageId: number; caseId: string; classification: DiscoveryOutcome; evidence: string }) {
    const current = await this.latest(ctx.memberId, input.caseId);
    if (!current || current.state.status !== "AWAITING_OUTCOME") return { ok: false, message: "Không tìm thấy case đang chờ outcome thuộc manager này." };
    if (current.state.chatId !== ctx.chatId || current.state.messageThreadId !== ctx.messageThreadId) return { ok: false, message: `Case ${input.caseId} thuộc topic ${current.state.provinceName || "khác"}. Hãy ghi outcome tại đúng topic.` };
    const gateMessage = outcomeTimeGate(current.state.outcomeDueAt);
    if (gateMessage) return { ok: false, message: gateMessage };
    const now = new Date().toISOString();
    const state: Mb03DiscoveryState = { ...current.state, status: "COMPLETED", updatedAt: now, outcome: { classification: input.classification, evidence: input.evidence, recordedAt: now } };
    await this.persistInbound(ctx, input.updateId, input.messageId, null, input.evidence, current.state);
    await this.persistOutbound(ctx, state, `Đã ghi outcome ${input.classification} cho ${input.caseId}. Đây là discovery evidence; không thay đổi Decision Core và không tạo work order.`);
    return { ok: true, message: `Đã ghi ${input.classification} cho ${input.caseId}.` };
  }
}
