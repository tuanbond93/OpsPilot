import type { OperationalCohort } from "@/domain/operational-learning/checkpoint-policy";
import { formatTeamLeadActionMessage, type TeamLeadWarehouseClass } from "./team-lead-action";

type TelegramRecipient = { displayName: string; username?: string | null };

export type FirstPushTelegramContext = {
  incidentKey: string;
  warehouseName: string;
  reasonName: string;
  affectedOrderCount: number;
  maximumAgeHours?: number | null;
  orderCodes?: string[];
  reasonCode?: string;
  structuredOutboundResponses?: boolean;
  provinceName?: string;
  warehouseClass?: TeamLeadWarehouseClass;
  previousResponseLabel?: string | null;
  orderEvidence?: Array<{ orderCode: string; status?: string | null; observedAt?: string | null; source: "RILLNET_OBSERVED" | "GHN_VERIFIED" | "HUMAN_VERIFICATION_REQUIRED"; ghnStatus?: string | null; ghnVerifiedAt?: string | null }>;
};

type CohortEvidenceMember = { orderCode: string; status?: string | null; observedAt?: string | null; source?: string | null };

export function logicalReminderOrderCodes(members: Array<CohortEvidenceMember & { lastReminderAt?: string | null }>, attemptMarker: string | null | undefined) {
  return [...new Set(members.filter((member) => Boolean(attemptMarker) && member.lastReminderAt === attemptMarker).map((member) => member.orderCode))];
}

export function buildRillnetOrderEvidence(orderCodes: string[], members: CohortEvidenceMember[]) {
  return [...new Set(orderCodes)].map((orderCode) => {
    const member = members.find((item) => item.orderCode === orderCode && item.source === "rillnet");
    return member?.status?.trim() && member.observedAt
      ? { orderCode, status: member.status, observedAt: member.observedAt, source: "RILLNET_OBSERVED" as const }
      : { orderCode, source: "HUMAN_VERIFICATION_REQUIRED" as const };
  });
}

export function buildCanonicalTelegramReminderContext(input: {
  incidentKey: string;
  warehouseName: string;
  reasonCode?: string;
  reasonName: string;
  affectedOrderCount: number;
  maximumAgeHours?: number | null;
  structuredOutboundResponses?: boolean;
  provinceName?: string;
  warehouseClass?: TeamLeadWarehouseClass;
  previousResponseLabel?: string | null;
  reminderOrderCodes?: string[];
  targets: Array<{ operationalCohort?: OperationalCohort | null; actionMarker?: string | null }>;
}): FirstPushTelegramContext {
  const orderCodes = [...new Set(input.reminderOrderCodes?.length
    ? input.reminderOrderCodes
    : input.targets.flatMap(({ operationalCohort, actionMarker }) =>
      logicalReminderOrderCodes(operationalCohort?.members || [], actionMarker),
    ))];
  const members = input.targets.flatMap(({ operationalCohort }) => operationalCohort?.members || []);
  return {
    incidentKey: input.incidentKey,
    warehouseName: input.warehouseName,
    reasonCode: input.reasonCode,
    reasonName: input.reasonName,
    affectedOrderCount: input.affectedOrderCount,
    maximumAgeHours: input.maximumAgeHours,
    structuredOutboundResponses: input.structuredOutboundResponses,
    provinceName: input.provinceName,
    warehouseClass: input.warehouseClass,
    previousResponseLabel: input.previousResponseLabel,
    orderCodes,
    orderEvidence: buildRillnetOrderEvidence(orderCodes, members),
  };
}

export type FollowupReminderStage = "FIRST" | "SECOND" | "THIRD" | "ESCALATION";

const stageLabel: Record<FollowupReminderStage, string> = {
  FIRST: "NHẮC LẦN 1",
  SECOND: "NHẮC LẦN 2",
  THIRD: "NHẮC LẦN 3",
  ESCALATION: "CẦN MANAGER CAN THIỆP",
};

function escapeTelegramHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function orderLookupLink(orderCode: string) {
  const safeCode = escapeTelegramHtml(orderCode);
  const lookupUrl = `https://tracuunoibo.ghn.vn/internal?order_code=${encodeURIComponent(orderCode)}`;
  return `- <a href="${lookupUrl}">${safeCode}</a>`;
}

export function formatTelegramFollowupReminder(
  stage: FollowupReminderStage,
  context: FirstPushTelegramContext,
  _recipients: TelegramRecipient[]
) {
  if (context.structuredOutboundResponses && context.warehouseClass && context.warehouseClass !== "UNKNOWN") {
    return formatTeamLeadActionMessage({ stage, province: context.provinceName || "Chưa xác định", warehouseName: context.warehouseName, warehouseClass: context.warehouseClass, reasonCode: context.reasonCode || "", orderCodes: context.orderCodes || [], previousResponseLabel: context.previousResponseLabel });
  }
  const allOrders = [...new Set(context.orderCodes || [])];
  const orders = allOrders.slice(0, 30);
  const needsManager = stage === "ESCALATION";
  const evidence = context.orderEvidence || [];
  const evidenceLines = evidence.flatMap(item => {
    const observed = item.status && item.observedAt
      ? ["Đơn:", `${escapeTelegramHtml(item.orderCode)} — ${escapeTelegramHtml(item.status)}`, "Nguồn:", `Rillnet · cập nhật ${escapeTelegramHtml(item.observedAt)}`]
      : ["Đơn:", `${escapeTelegramHtml(item.orderCode)} — Chưa xác minh được trạng thái hiện tại.`];
    if (item.ghnStatus && item.ghnVerifiedAt) observed.push(`GHN xác minh: ${escapeTelegramHtml(item.ghnStatus)} · ${escapeTelegramHtml(item.ghnVerifiedAt)}`);
    return [...observed, ""];
  });
  const actionLines = needsManager
    ? ["Cần kiểm tra:", "Manager xác nhận hướng xử lý và trạng thái thực tế của đơn."]
    : context.reasonCode === "KHO_TON"
      ? ["Cần kiểm tra:", "Xác nhận đơn hiện thuộc trường hợp nào:", "- đã có lịch xuất/chuyển;", "- đang chờ xe/chuyến;", "- chưa tới COT xuất;", "- hoặc có nguyên nhân khác."]
      : context.reasonCode === "KHO_CHU_A_LUAN_CHUYEN"
        ? ["Cần kiểm tra:", "Xác nhận đơn:", "- đã có lịch xuất/chuyển chưa;", "- đã có xe/chuyến nhận hàng chưa;", "- hay vẫn chưa tới COT xuất."]
        : ["Cần kiểm tra:", "Kiểm tra tình trạng xử lý thực tế và cập nhật nguyên nhân / hướng xử lý."];
  return [
    `<b>${stageLabel[stage]}</b>`,
    `Sự cố: ${escapeTelegramHtml(context.reasonName)}`,
    `Kho phụ trách: ${escapeTelegramHtml(context.warehouseName)}`,
    ...evidenceLines,
    `OpsPilot phát hiện: ${escapeTelegramHtml(context.reasonName)}`,
    ...actionLines,
    "",
    "Mã đơn cần kiểm tra:",
    orders.length ? [orders.map(orderLookupLink).join("\n"), allOrders.length > orders.length ? `- … và ${allOrders.length - orders.length} mã khác trên OpsPilot` : ""].filter(Boolean).join("\n") : "- Chưa có mã đơn trong snapshot; báo Manager trước khi kết luận.",
    "",
    context.structuredOutboundResponses
      ? "<b>Chọn một phản hồi bên dưới.</b> Chỉ Reply nếu chọn Khác; không cần nhập lại mã đơn."
      : needsManager
      ? "<b>Reply theo từng dòng:</b>\nMÃ_ĐƠN: nguyên nhân / hướng xử lý\nChưa có xử lý sau 3 lần nhắc; Manager xác nhận hướng xử lý tiếp theo."
      : "<b>Reply theo từng dòng:</b>\nMÃ_ĐƠN: nguyên nhân / hướng xử lý",
  ].join("\n");
}

export function formatTelegramFollowupFirstPush(context: FirstPushTelegramContext, recipients: TelegramRecipient[]) {
  return formatTelegramFollowupReminder("FIRST", context, recipients);
}
