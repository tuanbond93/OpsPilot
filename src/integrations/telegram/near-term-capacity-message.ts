import {
  formatSemanticOrders,
  formatSemanticWeight,
  type AiRecommendation,
  type CurrentRisk,
  type DecisionContext,
  type InboundEvidenceSnapshot,
  type LeadFact,
} from "@/domain/near-term-capacity";

function escape(value: string): string { return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!); }

/** New 3 decision-first quick action buttons for Lead */
export const inboundEvidenceActionButtons = [
  ["✅ Đã có phương án", "ACTION_PLANNED"],
  ["⚠️ Có ngoại lệ", "EXCEPTION_REPORTED"],
  ["🆘 Cần hỗ trợ", "ASSISTANCE_REQUESTED"],
] as const;

export type InboundEvidenceAction = typeof inboundEvidenceActionButtons[number][1];

// Retain the exported name while making every live callback an operational
// context action. No live Telegram prompt may collect inbound KG, ETA, or type.
export const nearTermFactButtons = inboundEvidenceActionButtons;
// Retired values remain renderable for historical records, but have no callback
// code and cannot enter through Telegram.
type RetiredNearTermFactAnswer = "CONFIRMED_ETA" | "UNCERTAIN_ETA" | "NO_SIGNIFICANT_INCOMING" | "UNKNOWN";
export type NearTermFactAnswer = InboundEvidenceAction | RetiredNearTermFactAnswer;

const compactAnswerCodes: Partial<Record<NearTermFactAnswer, string>> = {
  ACTION_PLANNED: "P",
  EXCEPTION_REPORTED: "E",
  ASSISTANCE_REQUESTED: "S",
};
const answerByCompactCode = Object.fromEntries(Object.entries(compactAnswerCodes).flatMap(([answer, code]) => code ? [[code, answer]] : [])) as Record<string, NearTermFactAnswer | undefined>;

export function buildNearTermFactCallbackData(caseId: string, answer: NearTermFactAnswer) {
  const code = compactAnswerCodes[answer];
  if (!code) throw new Error("INVALID_NEAR_TERM_FACT_CALLBACK");
  const value = `opspcap:${caseId}:${code}`;
  if (!/^opspcap:[0-9a-f-]{36}:[PES]$/i.test(value) || Buffer.byteLength(value) > 64) throw new Error("INVALID_NEAR_TERM_FACT_CALLBACK");
  return value;
}

export function parseNearTermFactCallbackData(value: unknown): { caseId: string; answer: NearTermFactAnswer } | null {
  if (typeof value !== "string" || Buffer.byteLength(value) > 64) return null;
  const compact = /^opspcap:([0-9a-f-]{36}):([PES])$/i.exec(value);
  if (compact) {
    const answer = answerByCompactCode[compact[2].toUpperCase()];
    return answer ? { caseId: compact[1].toLowerCase(), answer } : null;
  }
  return null;
}

/** Formats operational exception reply prompt */
export function formatOperationalExceptionPrompt(): string {
  return "Vui lòng reply tin nhắn này để nêu rõ ngoại lệ vận hành tại kho (ví dụ: xe hỏng, thiếu người bốc xếp, kho gặp sự cố...).";
}

export const nearTermFactAnswerLabels: Record<NearTermFactAnswer, string> = {
  CONFIRMED_ETA: "Đã lưu từ luồng lịch sử",
  UNCERTAIN_ETA: "Đã lưu từ luồng lịch sử",
  NO_SIGNIFICANT_INCOMING: "Đã lưu từ luồng lịch sử",
  UNKNOWN: "Chưa xác định",
  ACTION_PLANNED: "Đã có phương án",
  EXCEPTION_REPORTED: "Có ngoại lệ vận hành",
  ASSISTANCE_REQUESTED: "Cần hỗ trợ năng lực",
};

/**
 * Formats decision-first Lead prompt using deterministic Inbound Evidence snapshot.
 * Eliminates manual Lead volume estimation.
 */
export function formatInboundEvidenceLeadPrompt(snapshot: InboundEvidenceSnapshot): string {
  const warehouse = escape(snapshot.warehouseName || snapshot.warehouseId);
  const horizonText = snapshot.horizon
    ? `${formatVietnamTime(snapshot.horizon.start)} – ${formatVietnamTime(snapshot.horizon.end)}`
    : "Trong khung giờ hôm nay (07:00–17:00)";

  const backlog = snapshot.currentBacklog;
  const inbound = snapshot.inbound;

  const backlogKnownWeight = backlog.knownOrders > 0
    ? `${backlog.knownWeightKg} kg (${backlog.knownOrders} đơn)`
    : "Chưa có dữ liệu";
  const backlogUnknownWeight = backlog.unknownWeightOrders > 0
    ? `\n• Đơn chưa có khối lượng: ${backlog.unknownWeightOrders} đơn`
    : "";

  const picked = inbound.pickedNotTransferred;
  const pickedWeight = picked.knownOrders > 0 ? `${picked.knownWeightKg} kg` : "Chưa có kg";
  const pickedUnknown = picked.unknownWeightOrders > 0 ? `; ${picked.unknownWeightOrders} đơn chưa có kg` : "";

  const transfer = inbound.inTransfer;
  const transferWeight = transfer.knownOrders > 0 ? `${transfer.knownWeightKg} kg` : "Chưa có kg";
  const transferUnknown = transfer.unknownWeightOrders > 0 ? `; ${transfer.unknownWeightOrders} đơn chưa có kg` : "";

  const totalPipeline = inbound.pipeline_orders ?? (picked.orderCount + transfer.orderCount);
  const etaKnown = inbound.eta_known_orders ?? inbound.etaKnownOrders ?? 0;

  let etaLine = `• ETA xác định: ${etaKnown}/${totalPipeline} đơn\n• Thời điểm hàng về: CHƯA XÁC ĐỊNH`;
  if (etaKnown > 0 && inbound.earliestEta) {
    const timing = inbound.earliestEta === inbound.latestEta || !inbound.latestEta
      ? `Khoảng ${formatVietnamTime(inbound.earliestEta)}`
      : `Từ ${formatVietnamTime(inbound.earliestEta)} đến ${formatVietnamTime(inbound.latestEta)}`;
    etaLine = `• ETA xác định: ${etaKnown}/${totalPipeline} đơn (${timing})`;
  }

  let assessmentBlock = [
    "⚠️ OpsPilot đánh giá:",
    totalPipeline > 50
      ? "• Lượng hàng upstream đang lớn."
      : "• Lượng hàng upstream trong giới hạn bình thường.",
    "• Chưa đủ bằng chứng xác định bao nhiêu đơn sẽ về trước 17:00.",
  ].join("\n");

  if (snapshot.status === "OUTSIDE_OPERATING_WINDOW") {
    assessmentBlock = [
      "⚠️ OpsPilot đánh giá:",
      "• Ngoài khung giờ giao hàng (07:00–17:00).",
      "• Không kích hoạt can thiệp xử lý trong ngày.",
    ].join("\n");
  }

  return [
    "🟠 OPSPILOT — CẢNH BÁO NĂNG LỰC XỬ LÝ",
    "",
    `Kho: ${warehouse}`,
    `Khung giờ theo dõi: ${horizonText}`,
    "",
    "📦 TỒN KHO HIỆN TẠI",
    `• Số đơn tồn: ${backlog.orderCount} đơn`,
    `• Khối lượng đã biết: ${backlogKnownWeight}${backlogUnknownWeight}`,
    "",
    "🚚 HÀNG ĐANG TRONG PIPELINE VỀ KHO",
    `• Đã lấy / đang chờ luân chuyển: ${picked.orderCount} đơn / ${pickedWeight}${pickedUnknown}`,
    `• Đang luân chuyển về kho: ${transfer.orderCount} đơn / ${transferWeight}${transferUnknown}`,
    etaLine,
    "",
    assessmentBlock,
    "",
    "👉 Xác nhận tình trạng xử lý của kho:",
  ].join("\n");
}

/** System-derived inbound evidence is authoritative; people provide context only. */
export function formatNearTermFactRequest(facts: CurrentRisk, windowMinutes: number) {
  const codes = Array.isArray(facts.orderCodes) ? facts.orderCodes.filter((code): code is string => typeof code === "string" && Boolean(code.trim())) : [];
  const shownCodes = codes.slice(0, 5);
  const remaining = Math.max(0, codes.length - shownCodes.length);
  const orderLines = shownCodes.length ? shownCodes.map((code) => `  - ${escape(code)}`) : ["  - Chưa có dữ liệu mã đơn"];
  if (remaining > 0) orderLines.push(`  - + ${remaining} đơn khác`);
  const riskReason = facts.currentKg == null
    ? "Dữ liệu khối lượng hiện có chưa đầy đủ."
    : "Tồn kho đang có đơn cần xử lý.";
  return [
    "🟠 OPSPILOT — TÌNH TRẠNG NĂNG LỰC XỬ LÝ", "", `Kho: ${escape(facts.warehouseName)}`, "",
    "📦 TÌNH HÌNH HIỆN TẠI", `• Đang tồn: ${formatSemanticOrders(facts.currentOrders)}`, `• Tổng khối lượng: ${formatSemanticWeight(facts.currentKg)}`, "• Đơn liên quan:", ...orderLines, "",
    "⚠️ RỦI RO OPSPILOT PHÁT HIỆN", `• ${riskReason}`, ...(facts.supportingChange ? [`• ${escape(facts.supportingChange)}`] : []), "",
    "🚚 OpsPilot đã tự đọc dữ liệu hàng đang trong pipeline về kho.",
    "Hệ thống sử dụng dữ liệu pickup / luân chuyển / khối lượng hiện có.",
    "ETA hiện chưa có nguồn xác thực nên không yêu cầu nhập tay KG/ETA/TYPE.",
    "Vui lòng chọn: ✅ Đã có phương án · ⚠️ Có ngoại lệ · 🆘 Cần hỗ trợ.",
  ].join("\n");
}

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
    approveMeaning: "Phê duyệt quyết định không bổ sung xe/năng lực tại thời điểm hiện tại và tiếp tục theo dõi.",
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
    "",
    "📌 LÝ DO",
    escape(decision.reason_summary),
    "",
    ...(isNoAction
      ? [
          "✅ NẾU APPROVE",
          "",
          "Ghi nhận quyết định:",
          "Không bổ sung xe/năng lực tại thời điểm hiện tại.",
          "",
          "Kho tiếp tục xử lý theo năng lực hiện có.",
          "OpsPilot tiếp tục theo dõi tại checkpoint tiếp theo.",
        ]
      : [
          "✅ NẾU APPROVE",
          `• ${escape(displayMeta.approveMeaning)}`,
        ]),
    "",
    ...impactLines,
    "",
    `⏰ Cần quyết định trước: ${escape(decision.required_by)}`,
    `🔄 Kiểm tra lại: ${nextCheck}`,
    `💰 Trade-off: ${money}`,
    `🧾 Evidence: ${escape(facts.capturedAt)}`,
    `🎯 Confidence: ${Math.round(decision.confidence * 100)}%`,
    `🏷️ Mã kỹ thuật: ${escape(decision.recommended_action)}`,
  ].join("\n");
}
