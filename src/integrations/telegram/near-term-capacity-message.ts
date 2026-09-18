import {
  formatSemanticOrders,
  formatSemanticWeight,
  type AiRecommendation,
  type CurrentRisk,
  type DecisionContext,
  type LeadFact,
} from "@/domain/near-term-capacity";

function escape(value: string): string { return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!); }

/** Fact-only prompt: Lead is never asked to choose an operational action. */
export function formatNearTermFactRequest(facts: CurrentRisk, windowMinutes: number) {
  const codes = Array.isArray(facts.orderCodes) ? facts.orderCodes.filter((code): code is string => typeof code === "string" && Boolean(code.trim())) : [];
  const shownCodes = codes.slice(0, 5);
  const remaining = Math.max(0, codes.length - shownCodes.length);
  const orderLines = shownCodes.length ? shownCodes.map((code) => `  - ${escape(code)}`) : ["  - Chưa có dữ liệu mã đơn"];
  if (remaining > 0) orderLines.push(`  - + ${remaining} đơn khác`);
  const riskReason = facts.currentKg == null
    ? "Thiếu dữ liệu khối lượng; cần Lead xác nhận thêm để đánh giá năng lực xử lý"
    : "Tồn kho đang có đơn cần xử lý; OpsPilot cần kiểm tra nguy cơ không xử lý hết hàng trong 4 giờ tới";
  return [
    "🟠 OPSPILOT — CẦN XÁC NHẬN NĂNG LỰC XỬ LÝ", "", `Kho: ${escape(facts.warehouseName)}`, "",
    "📦 TÌNH HÌNH HIỆN TẠI", `• Đang tồn: ${formatSemanticOrders(facts.currentOrders)}`, `• Tổng khối lượng: ${formatSemanticWeight(facts.currentKg)}`, "• Đơn liên quan:", ...orderLines, "",
    "⚠️ RỦI RO OPSPILOT PHÁT HIỆN", `• ${riskReason}`, ...(facts.supportingChange ? [`• ${escape(facts.supportingChange)}`] : []), "",
    "💡 OPSPILOT CẦN LEAD XÁC NHẬN", `Trong ${Math.round(windowMinutes / 60)} giờ tới, kho có dự kiến nhận thêm lượng hàng đáng kể không?`,
    "Thông tin này được dùng để đánh giá kho có nguy cơ không xử lý hết hàng trong thời gian tới hay không.",
  ].join("\n");
}

export const nearTermFactButtons = [
  ["Có — biết khá chắc giờ hàng về", "CONFIRMED_ETA"], ["Có — nhưng chưa chắc giờ hàng về", "UNCERTAIN_ETA"],
  ["Không có thêm đáng kể", "NO_SIGNIFICANT_INCOMING"], ["Chưa xác định", "UNKNOWN"],
] as const;

export type NearTermFactAnswer = typeof nearTermFactButtons[number][1];
const compactAnswerCodes: Record<NearTermFactAnswer, string> = {
  CONFIRMED_ETA: "C",
  UNCERTAIN_ETA: "U",
  NO_SIGNIFICANT_INCOMING: "N",
  UNKNOWN: "X",
};
const answerByCompactCode = Object.fromEntries(Object.entries(compactAnswerCodes).map(([answer, code]) => [code, answer])) as Record<string, NearTermFactAnswer | undefined>;
const legacyAnswerPattern = "CONFIRMED_ETA|UNCERTAIN_ETA|NO_SIGNIFICANT_INCOMING|UNKNOWN";
export function buildNearTermFactCallbackData(caseId: string, answer: NearTermFactAnswer) {
  const value = `opspcap:${caseId}:${compactAnswerCodes[answer]}`;
  if (!/^opspcap:[0-9a-f-]{36}:[CUNX]$/i.test(value) || Buffer.byteLength(value) > 64) throw new Error("INVALID_NEAR_TERM_FACT_CALLBACK");
  return value;
}
export function parseNearTermFactCallbackData(value: unknown): { caseId: string; answer: NearTermFactAnswer } | null {
  if (typeof value !== "string" || Buffer.byteLength(value) > 64) return null;
  const compact = /^opspcap:([0-9a-f-]{36}):([CUNX])$/i.exec(value);
  if (compact) {
    const answer = answerByCompactCode[compact[2].toUpperCase()];
    return answer ? { caseId: compact[1].toLowerCase(), answer } : null;
  }
  const legacy = new RegExp(`^opspcap:([0-9a-f-]{36}):(${legacyAnswerPattern})$`, "i").exec(value);
  return legacy ? { caseId: legacy[1].toLowerCase(), answer: legacy[2].toUpperCase() as NearTermFactAnswer } : null;
}
export function formatNearTermDetailRequest() {
  return "Vui lòng reply đúng 1 dòng: KG=<số>; ETA=<ISO-8601>; TYPE=B2B|ECOM|MIXED. Chỉ cung cấp facts, không chọn phương án xử lý.";
}

export const nearTermFactAnswerLabels: Record<NearTermFactAnswer, string> = {
  CONFIRMED_ETA: "Có — biết khá chắc giờ hàng về",
  UNCERTAIN_ETA: "Có — nhưng chưa chắc giờ hàng về",
  NO_SIGNIFICANT_INCOMING: "Không có thêm hàng đáng kể",
  UNKNOWN: "Chưa xác định",
};

export function formatVietnamTime(dateOrIso: Date | string): string {
  const d = typeof dateOrIso === "string" ? new Date(dateOrIso) : dateOrIso;
  const utc = d.getTime();
  const vnTime = new Date(utc + 7 * 3600 * 1000);
  const hours = String(vnTime.getUTCHours()).padStart(2, "0");
  const minutes = String(vnTime.getUTCMinutes()).padStart(2, "0");
  const day = String(vnTime.getUTCDate()).padStart(2, "0");
  const month = String(vnTime.getUTCMonth() + 1).padStart(2, "0");
  return `${hours}:${minutes} ${day}/${month}`;
}

/** Persistent confirmation block appended to original fact request message once answered. */
export function formatNearTermFactConfirmation(
  originalText: string,
  confirmation: {
    answer: NearTermFactAnswer;
    responderName: string;
    responderRole?: string;
    answeredAt: Date | string;
  }
): string {
  const answerLabel = nearTermFactAnswerLabels[confirmation.answer] || confirmation.answer;
  const roleSuffix = confirmation.responderRole ? ` (${confirmation.responderRole})` : "";
  const responder = `${confirmation.responderName}${roleSuffix}`.trim();
  const timeStr = formatVietnamTime(confirmation.answeredAt);

  const block = [
    "",
    "✅ ĐÃ GHI NHẬN PHẢN HỒI",
    "",
    "Phản hồi:",
    answerLabel,
    "",
    "Người xác nhận:",
    responder,
    "",
    "Thời gian:",
    timeStr,
    "",
    "🤖 OpsPilot đang phân tích và sẽ gửi quyết định cho Manager.",
  ].join("\n");

  return `${originalText}\n${block}`;
}

export const actionDisplayMetadata: Record<
  string,
  {
    title: string;
    subtitle: string;
    approveMeaning: string;
  }
> = {
  NO_ACTION_MONITOR: {
    title: "CHƯA ĐIỀU THÊM XE TRONG 4 GIỜ TỚI",
    subtitle: "Tiếp tục xử lý bằng năng lực hiện tại và theo dõi lại tại checkpoint tiếp theo.",
    approveMeaning: "Giữ nguyên bố trí hiện tại, tiếp tục theo dõi, OpsPilot không điều thêm xe / không can thiệp.",
  },
  ADD_VEHICLE: {
    title: "ĐIỀU ĐỘNG THÊM XE TĂNG CƯỜNG",
    subtitle: "Bổ sung xe để giải tỏa lượng hàng dồn ứ kịp deadline.",
    approveMeaning: "OpsPilot sẽ ghi nhận phê duyệt bổ sung phương tiện vận tải theo đề xuất.",
  },
  HOLD_LOW_PRIORITY_ECOM: {
    title: "TẠM GIỮ HÀNG ECOM ƯU TIÊN THẤP",
    subtitle: "Tập trung năng lực xử lý hàng B2B và đơn ưu tiên cao.",
    approveMeaning: "OpsPilot sẽ ghi nhận phê duyệt tạm giữ hàng thương mại điện tử ưu tiên thấp.",
  },
  ADD_MANPOWER: {
    title: "TĂNG CƯỜNG NHÂN LỰC XỬ LÝ",
    subtitle: "Bổ sung nhân sự tại trạm để đẩy nhanh tiến độ phân loại/bốc xếp.",
    approveMeaning: "OpsPilot sẽ ghi nhận phê duyệt tăng cường nhân lực tại trạm.",
  },
  REALLOCATE_AVAILABLE_CAPACITY: {
    title: "ĐIỀU PHỐI LẠI NĂNG LỰC HIỆN CÓ",
    subtitle: "Tối ưu hóa các tuyến xe và nguồn lực sẵn có trong khu vực.",
    approveMeaning: "OpsPilot sẽ ghi nhận phê duyệt tái phân bổ năng lực hiện có.",
  },
  HUMAN_INVESTIGATION_REQUIRED: {
    title: "CẦN ĐIỀU TRA VẬN HÀNH TRỰC TIẾP",
    subtitle: "Dữ liệu chưa đủ chắc chắn; đề nghị Manager/Lead kiểm tra thực tế.",
    approveMeaning: "OpsPilot sẽ chuyển case sang chế độ theo dõi chuyên sâu của con người.",
  },
};

/** Manager sees human-readable operational recommendation, explicit Approve semantics, and decision-aware copy. */
export function formatNearTermManagerCard(
  warehouseName: string,
  facts: CurrentRisk,
  lead: LeadFact,
  context: DecisionContext,
  decision: AiRecommendation
) {
  const isNoAction = decision.recommended_action === "NO_ACTION_MONITOR";
  const displayMeta = actionDisplayMetadata[decision.recommended_action] || {
    title: decision.recommended_action,
    subtitle: "Thực hiện theo khuyến nghị của hệ thống.",
    approveMeaning: `OpsPilot sẽ ghi nhận phê duyệt hành động ${decision.recommended_action}.`,
  };

  const money = decision.estimated_cost_vnd == null && decision.estimated_saving_vnd == null
    ? "Chưa đủ dữ liệu xác minh chi phí"
    : `Chi phí: ${decision.estimated_cost_vnd ?? "—"}; tiết kiệm: ${decision.estimated_saving_vnd ?? "—"}`;

  const leadAnswerText = nearTermFactAnswerLabels[lead.incoming as NearTermFactAnswer] || lead.incoming;
  const leadFactLine = `• Facts từ Lead: ${escape(leadAnswerText)}${lead.expectedIncomingKg != null ? ` · ${lead.expectedIncomingKg} kg` : ""}${lead.expectedIncomingAt ? ` · ETA ${escape(lead.expectedIncomingAt)}` : ""}`;

  const nextCheck = decision.required_followup_at
    ? formatVietnamTime(decision.required_followup_at)
    : "Checkpoint tiếp theo";

  // Decision-aware operational impact copy:
  // For NO_ACTION_MONITOR: avoid contradictory "Nếu không làm / Nếu thực hiện"
  const impactLines: string[] = isNoAction
    ? [
        "Nếu duy trì hiện trạng:",
        escape(decision.expected_state_if_action || decision.expected_state_if_no_action),
        "",
        "⚠️ Rủi ro cần theo dõi:",
        escape(decision.current_risk),
        "",
        "Điều kiện cần xem xét can thiệp:",
        `Phát sinh hàng về đột xuất hoặc tồn kho không giải tỏa tại checkpoint tiếp theo (${nextCheck}).`,
      ]
    : [
        "Nếu không làm:",
        escape(decision.expected_state_if_no_action),
        "",
        "Nếu thực hiện:",
        escape(decision.expected_state_if_action),
      ];

  return [
    "🧠 OPSPILOT — QUYẾT ĐỊNH CẦN PHÊ DUYỆT",
    "",
    `📍 Kho: ${escape(warehouseName)}`,
    "",
    "⚠️ Tình hình vận hành",
    escape(decision.current_risk),
    `• Hiện tại: ${formatSemanticWeight(facts.currentKg)} / ${formatSemanticOrders(facts.currentOrders)}`,
    leadFactLine,
    `• Bất định: ${escape(context.uncertainties.join(", ") || decision.uncertainties.join(", ") || "Không có")}`,
    "",
    "🤖 AI ĐỀ XUẤT",
    escape(displayMeta.title),
    escape(displayMeta.subtitle),
    `[Mã kỹ thuật: ${escape(decision.recommended_action)}]`,
    "",
    "📌 LÝ DO",
    escape(decision.reason_summary),
    "",
    "✅ NẾU APPROVE",
    `• ${escape(displayMeta.approveMeaning)}`,
    "",
    ...impactLines,
    "",
    `⏰ Cần quyết định trước: ${escape(decision.required_by)}`,
    `🔄 Kiểm tra lại: ${nextCheck}`,
    `💰 Trade-off: ${money}`,
    `🧾 Evidence: ${escape(facts.capturedAt)}`,
    `🎯 Confidence: ${Math.round(decision.confidence * 100)}%`,
  ].join("\n");
}
