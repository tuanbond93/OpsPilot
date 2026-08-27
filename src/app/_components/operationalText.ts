const FALLBACK_TRANSLATIONS: Record<string, string> = {
  "Kho hng": "Kho hàng",
  "L?i v?n hnh": "Lỗi vận hành",
  "Dynamic explanation unavailable": "Chưa có giải thích động",
  "No escalation required.": "Không cần leo thang.",
  "No executive summary available.": "Chưa có tóm tắt điều hành.",
  "Root cause not determined.": "Chưa xác định được nguyên nhân gốc.",
  "Review incident evidence with the responsible operations lead.": "Rà soát bằng chứng sự cố cùng đầu mối vận hành phụ trách trước khi đưa ra phương án.",
  "Human investigation is required before an operational decision can be made.": "Cần điều tra bổ sung bởi con người trước khi có thể đưa ra quyết định vận hành.",
};

/** Repairs legacy UTF-8/Latin-1 mojibake without changing normal text. */
export function repairOperationalText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const raw = String(value)
    .replaceAll("Dynamic explanation unavailable", "Chưa có giải thích từ AI")
    .replaceAll("&#x20;", " ");
  if (FALLBACK_TRANSLATIONS[raw]) return FALLBACK_TRANSLATIONS[raw];
  if (!/[ÃÂÄÅÆÐÑá»áº]/.test(raw)) return raw;
  const windows1252: Record<number, number> = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
    0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
    0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
    0x017e: 0x9e, 0x0178: 0x9f,
  };
  const canEncode = (char: string) => char.charCodeAt(0) <= 255 || windows1252[char.charCodeAt(0)] !== undefined;
  const decode = (segment: string) => {
    if (!/[ÃÂÄÅÆÐÑá»áº]/.test(segment)) return segment;
    try {
      const bytes = Uint8Array.from([...segment], (char) => windows1252[char.charCodeAt(0)] ?? char.charCodeAt(0));
      const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return repaired.includes("�") ? segment : repaired;
    } catch { return segment; }
  };
  return raw.split(/([ \t\r\n]+)/).map((token) => {
    if (!/[ÃÂÄÅÆÐÑá»áº]/.test(token)) return token;
    let output = "";
    let segment = "";
    for (const char of token) {
      if (canEncode(char)) segment += char;
      else { output += decode(segment) + char; segment = ""; }
    }
    return output + decode(segment);
  }).join("");
}

export function translateStatus(value: unknown): string {
  const status = repairOperationalText(value).toUpperCase();
  return ({
    PENDING: "CHỜ DUYỆT",
    APPROVED: "ĐÃ PHÊ DUYỆT",
    EDITED: "ĐÃ CHỈNH SỬA",
    REJECTED: "ĐÃ TỪ CHỐI",
    DRAFT: "BẢN NHÁP",
    EXPIRED: "ĐÃ HẾT HẠN",
    SENT: "ĐÃ GỬI",
    FAILED: "GỬI THẤT BẠI",
    PROCESSING: "ĐANG XỬ LÝ",
    CANCELLED: "ĐÃ HỦY",
    SUPERSEDED: "ĐÃ THAY THẾ",
    NONE: "CHƯA CÓ",
    LOW: "THẤP",
    MEDIUM: "TRUNG BÌNH",
    HIGH: "CAO",
    CRITICAL: "NGHIÊM TRỌNG",
    FIRST_PUSH_PENDING: "CHỜ NHẮC LẦN ĐẦU",
    SECOND_PUSH_PENDING: "CHỜ NHẮC LẦN TIẾP THEO",
    ESCALATION_PENDING: "CHỜ BÁO CẤP TRÊN",
    ESCALATED: "ĐÃ BÁO CẤP TRÊN",
    WAITING_FOR_RESPONSE: "CHỜ PHẢN HỒI",
    NEXT_CHECK_PENDING: "CHỜ KIỂM TRA LẠI",
    RESOLVED: "ĐÃ KẾT THÚC THEO DÕI",
    CLOSED: "ĐÃ ĐÓNG",
    CONTINUE_MONITORING: "TIẾP TỤC THEO DÕI",
    PREPARE_ESCALATION: "CHUẨN BỊ BÁO CẤP TRÊN",
    STRONG_PROGRESS: "CẢI THIỆN MẠNH",
    LIMITED_PROGRESS: "CÓ CẢI THIỆN",
    NO_PROGRESS: "CHƯA CẢI THIỆN",
    NO_MATERIAL_PROGRESS: "CHƯA CẢI THIỆN ĐÁNG KỂ",
    WORSENING: "XẤU ĐI",
    INSUFFICIENT_DATA: "CHƯA ĐỦ DỮ LIỆU",
    UNKNOWN: "CHƯA XÁC ĐỊNH",
  } as Record<string, string>)[status] || repairOperationalText(value);
}

export function orderStatusLabel(value: unknown): string {
  const status = repairOperationalText(value).toLowerCase();
  return ({
    storing: "Đang lưu tại kho",
    ready_to_pick: "Đang chờ lấy hàng",
    picking: "Đang lấy hàng",
    picked: "Đã lấy hàng",
    transporting: "Đang luân chuyển",
    delivering: "Đang giao hàng",
    delivered: "Đã giao hàng",
    success: "Giao thành công",
    returning: "Đang hoàn hàng",
    waiting_to_return: "Đang chờ hoàn hàng",
    return_transporting: "Đang luân chuyển hoàn",
  } as Record<string, string>)[status] || repairOperationalText(value);
}

export function incidentSignalLabel(reason: unknown): string {
  const value = repairOperationalText(reason);
  return ({
    "Thiếu shipper": "Tín hiệu giao hàng kéo dài",
    "Kho tồn": "Đơn đang lưu kho tại thời điểm chụp dữ liệu",
    "Kho chưa lấy": "Tín hiệu chờ lấy kéo dài",
    "Kho chưa luân chuyển": "Tín hiệu luân chuyển kéo dài",
  } as Record<string, string>)[value] || value;
}

export function incidentRuleExplanation(reason: unknown): string {
  const value = repairOperationalText(reason);
  return ({
    "Thiếu shipper": "Đơn có trạng thái delivering và tuổi tính từ thời điểm tạo đơn lớn hơn 12 giờ.",
    "Kho tồn": "Đơn có trạng thái storing; cấu hình hiện tại ghi nhận từ 0 giờ.",
    "Kho chưa lấy": "Đơn có trạng thái ready_to_pick và tuổi tính từ thời điểm tạo đơn lớn hơn 24 giờ.",
    "Kho chưa luân chuyển": "Đơn có trạng thái transporting và tuổi tính từ thời điểm tạo đơn lớn hơn 24 giờ.",
  } as Record<string, string>)[value] || "Đơn khớp rule trạng thái và tuổi đơn hiện hành.";
}
